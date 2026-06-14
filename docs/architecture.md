# Mantle Push — Architecture

_How the relay is built and why. For running it see [`../README.md`](../README.md);
for deploying it see [`deploy.md`](deploy.md); for the end-to-end product design
see [`../../mantle-companion/docs/push-notifications.md`](../../mantle-companion/docs/push-notifications.md)._

---

## 1. What this service is

Mantle Push is a **blind, end-to-end-encrypted push relay**. A self-hosted
Mantle backend can't deliver a push notification to the store-distributed
companion app on its own — only the holder of the app's Apple (APNs) and Google
(FCM) credentials can. Mantle Push is that credential-holder, made deliberately
**blind**: every payload it forwards is a libsodium sealed box it cannot open. It
learns *routing metadata* (which device, when, ciphertext size) and nothing else.

It does exactly three things:

1. Lets a Mantle install **claim an identity** (`/instances`, trust-on-first-use).
2. **Enrolls devices** under that identity and hands back opaque routing handles
   (`/enroll`).
3. **Forwards sealed ciphertext** to a device via APNs/FCM (`/notify`).

Everything else (key generation, sealing, opening, content) happens at the two
ends — the user's Mantle and the device — never here.

---

## 2. The constraint it exists to solve

A store app has **one** bundle id and **one** set of push credentials, held by
the publisher. Device push tokens are scoped to those credentials, so a
self-hoster's backend physically cannot push to the app. A central, credentialed
relay is therefore **mandatory** for any store app — not a design preference.

The design turns that necessity into a privacy feature: the relay is a dumb pipe
for ciphertext, so "you must trust the publisher's relay" becomes "the relay
can't read your notifications even if it wanted to."

---

## 3. System context

```
   ┌──────────────────────┐                         ┌──────────────────────┐
   │  User's Mantle        │  (1) POST /instances    │   Mantle Push         │
   │  (self-hosted)        │ ───── TOFU claim ─────▶ │   (this service)      │
   │                       │                         │                       │
   │  holds: instance      │  (3) POST /notify       │  holds: APNs .p8 +    │
   │  token (long-lived),  │  Bearer instance token  │  FCM service acct,    │
   │  device public keys,  │  { routingToken,        │  instance→device map  │
   │  routing tokens        │    ciphertext }  ─────▶ │  (hashed tokens only) │
   └──────────┬────────────┘                         └──────────┬───────────┘
              │ seals payload to device pubkey                  │ forward ciphertext
              │ (libsodium crypto_box_seal)                     ▼
   ┌──────────▼────────────┐   (2) POST /enroll      ┌──────────────────────┐
   │  Companion app         │   { ticket, osToken } ▶ │   APNs / FCM          │
   │  iOS / Android         │ ◀──── routingToken ──── │   (ciphertext only)   │
   │  holds: device keypair │                         └──────────┬───────────┘
   │  (secret key on-device)│ ◀════════ sealed ciphertext ═══════╯
   │  opens + displays      │
   └────────────────────────┘
```

Three independent parties; the relay sits between Mantle and Apple/Google and
sees only opaque blobs.

---

## 4. Stack & runtime

- **Node + TypeScript + [Hono](https://hono.dev)**, run **directly via Node's
  native type-stripping** (Node ≥ 22.6) — *no build step*. Source TS is the
  deployable artifact. (Constraint: avoid strip-rejected TS — enums, namespaces,
  constructor parameter properties.)
- **Its own Postgres**, isolated from Mantle's "brain" DB so relay metadata never
  mingles with user data.
- **No external runtime deps for crypto**: APNs ES256 JWTs and FCM RS256 OAuth
  JWTs are signed with `node:crypto` directly (`src/push/jwt.ts`). Dependencies
  are just `hono`, `@hono/node-server`, and `pg`.
- Mostly stateless: the only in-process state is the rate-limiter windows and the
  cached provider tokens (both reconstructible). Horizontal scaling would move the
  rate limiter to Redis (today it's per-process).

---

## 5. Code map

```
src/
  index.ts        bootstrap: validate creds, serve (Hono), graceful shutdown
  app.ts          the HTTP surface — all routes, auth, rate limits
  config.ts       env parsing + validation (fail-fast); fileOrInline() secrets
  db.ts           pg Pool + query() helper
  migrate.ts      forward-only migration runner (_migrations ledger)
  lib/
    tokens.ts     generateToken (256-bit), hashToken (sha256), safeEqual
    ticket.ts     mint / decode / verify enrollment tickets (HMAC)
    store.ts      the ONLY module that touches SQL
    ratelimit.ts  per-instance fixed-window limiter (in-memory)
  push/
    index.ts      provider selection + per-platform dispatch
    types.ts      PushProvider / PushTarget / PushMessage / DeliveryResult
    apns.ts       APNs: HTTP/2 + ES256 .p8 JWT
    fcm.ts        FCM v1: RS256 service-account OAuth → messages:send
    mock.ts       logs deliveries; credential-less local/CI provider
    jwt.ts        ES256 / RS256 signing on node:crypto
migrations/0001_init.sql
scripts/
  smoke.ts        14-check end-to-end (mock) — register→enroll→notify→…
  smoke-live.ts   live-credential check (BadDeviceToken / FCM auth proof)
```

Layering: `app.ts` (HTTP + policy) → `lib/store.ts` (persistence) + `push/*`
(delivery). `store.ts` is the sole SQL boundary; routes never touch the DB
directly.

---

## 6. Data model

`migrations/0001_init.sql`. Note the **deliberate absences** — they're the whole
point of a blind relay.

```
instances(
  id                   uuid PK,
  instance_token_hash  bytea UNIQUE,   -- sha256(instanceToken)
  created_at, last_seen_at
)

devices(
  id                  uuid PK,
  instance_id         uuid → instances(id) ON DELETE CASCADE,
  platform            text CHECK ('ios' | 'android'),
  os_push_token       text,            -- APNs/FCM token (rotates)
  routing_token_hash  bytea UNIQUE,    -- sha256(routingToken)
  pubkey_fingerprint  text?,           -- optional, for the device list
  label               text?,
  created_at, last_seen_at, last_push_at
)
```

**Not stored, ever:** private keys, message bodies, plaintext titles, the Mantle
URL, or any raw token (only SHA-256 hashes). A full DB dump yields hashes that
can't be replayed as credentials and ciphertext sizes — never content.

---

## 7. Identity & the token model

Three secrets, deliberately separated so the relay stays blind and the long-lived
secret never reaches a device.

| Token | Created by | Held by | Stored at relay | Purpose |
|---|---|---|---|---|
| **Instance token** | the user's Mantle (auto, on first Connect) | Mantle only | `sha256` hash | authenticates Mantle→relay; identifies the install |
| **Enrollment ticket** | Mantle (signed with the instance token) | the app, briefly (~5 min) | — (verified, not stored) | lets the app enroll **without** holding the instance token |
| **Routing token** | the relay, at `/enroll` | app → handed to Mantle | `sha256` hash | opaque "this device under this install" handle |

All tokens are 256-bit (`randomBytes(32)`, base64url). Bearer auth hashes the
presented token and matches the hash column.

### 7.1 The enrollment ticket (the interesting bit)

The app talks to the relay to enroll, but must **not** hold the long-lived
instance token. So Mantle issues a short-lived, signed **ticket**:

```
wire format:  <base64url(payloadJSON)> . <base64url(hmac)>
payload    =  { iid, osPushToken, exp }        # iid = relay instance id; exp = unix secs
hmac       =  HMAC-SHA256(payloadB64, key = sha256(instanceToken))
```

The signing key is `sha256(instanceToken)` — which is **exactly what the relay
stores** as `instance_token_hash`. That's the crux:

- **Mantle** holds the raw token, derives `sha256(token)`, and signs.
- **The relay** already stores `sha256(token)`, so it re-derives the same key and
  verifies — *without ever holding the raw secret*.
- **The app** only ever sees a finished ticket (a signature), so it can't forge
  new ones, and the ticket expires in ~5 minutes and is bound to one device's OS
  push token (`osPushToken` in the payload).

`verifyTicket()` does a constant-time signature compare (`crypto.timingSafeEqual`)
then an expiry check. (`src/lib/ticket.ts`.)

> Trade-off, documented: using the stored hash as the HMAC key means a
> *compromised relay* could mint tickets — but a compromised relay already holds
> APNs/FCM and could spam/drop pushes anyway, and forged tickets still can't
> decrypt content. Domain-separating the ticket key from the storage hash is a
> noted future hardening.

---

## 8. Request flows

### 8.1 Connect (register → enroll → subscribe)

```
Mantle  ──POST /instances {instanceToken}──────────────▶  relay: TOFU upsert by hash → {instanceId}
Mantle  ── mints ticket(iid=instanceId, osPushToken) ──▶  (app receives ticket + relayUrl)
App     ──POST /enroll {ticket, platform, osPushToken}─▶  relay: verify ticket vs stored hash,
                                                            create device → {routingToken}
App     ── hands routingToken + device pubkey ─────────▶  Mantle stores it (push_subscriptions)
```

`/instances` is **trust-on-first-use**: the first caller presenting a given
256-bit token claims it (idempotent upsert on the hash). Unguessable token + "an
instance can only push to devices enrolled under its own token" ⇒ a self-claimed,
free token is safe (see §10).

### 8.2 Notify

```
Mantle  ──POST /notify  (Bearer instanceToken)
            { routingToken, ciphertext, collapseKey?, priority? }
relay:    auth instance by hash ─▶ rate-limit per instance ─▶ look up device by routingToken
          ─▶ assert device.instance_id == instance.id  (else 403)
          ─▶ dispatch to APNs|FCM by platform
            ├─ 200            → mark last_push_at, return {ok:true}
            ├─ unregistered   → delete the device row, return 410
            └─ other failure  → return 502 {reason}
```

The **"can only push to its own devices"** check (`device.instance_id ==
instance.id`) is what makes a self-claimed instance token safe — you can't push to
a stranger's device even if you guessed their routing token.

`unregistered` (APNs `410`/`BadDeviceToken`/`Unregistered`, FCM `404`/`UNREGISTERED`)
means the OS token is permanently dead, so the relay self-heals by pruning the row.

### 8.3 Lifecycle

- `POST /refresh` (routing-token auth) — the OS rotated the push token; update it.
- `DELETE /device` (routing **or** instance token) — unpair.
- `GET /instance` (instance-token auth) — list devices (metadata only).
- Instance **reset** is Mantle-side: it rolls a new instance token and
  re-registers (a fresh `instances` row); old routing tokens become unreachable.

---

## 9. Push providers

A small `PushProvider` interface (`send(target, message) → DeliveryResult`,
`close()`), dispatched by platform in `src/push/index.ts`.

- **APNs** (`apns.ts`): a persistent **HTTP/2** session to
  `api.push.apple.com` (or the sandbox host), `POST /3/device/<token>`. Auth is a
  **token-based ES256 JWT** signed from the `.p8` key, cached ~50 min (Apple
  requires refresh every 20–60 min). The sealed `ciphertext` rides in a custom
  `ct` key with `mutable-content: 1` so the app's Notification Service Extension
  decrypts before display. Maps APNs `reason` strings to `unregistered`.
- **FCM** (`fcm.ts`): mints an **OAuth access token** from the service account
  (RS256 JWT bearer grant, cached ~55 min), then `POST
  /v1/projects/<id>/messages:send` with a **data-only** message (so the app's
  background handler always runs) carrying `ct`. Maps FCM errors to `unregistered`.
- **mock** (`mock.ts`): logs each "delivery" and succeeds — the default, so the
  whole spine is verifiable from a CLI with **no Apple/Google credentials**
  (`scripts/smoke.ts`). Selected by `PUSH_PROVIDER=mock`.

`PUSH_PROVIDER=live` requires all APNs + FCM credentials present, enforced at boot
by `assertLiveCredentials()` (`config.ts`) — fail-fast, so a clean live boot
proves both providers loaded.

---

## 10. Security & threat model

| Party | Can see | Cannot see |
|---|---|---|
| **Mantle Push (this service)** | instance id, device id, OS push token, timestamps, ciphertext size, collapse key | notification content, the Mantle URL, message history, any private key |
| **APNs / FCM** | device token, ciphertext, timestamps | content (sealed) |
| **A leaked DB** | SHA-256 token *hashes*, metadata | raw tokens (not replayable), content |
| **A leaked instance token** | can enroll devices / exhaust rate limits / send blobs | content — blobs only decrypt on the user's own device's secret key; no forgery |

Mechanisms that back this up:
- **Blind relay** — only ciphertext transits; sealing/opening happen at the ends.
- **Hashed tokens at rest** (sha256), **constant-time** ticket verification.
- **Bounded blast radius** — an instance can only reach devices enrolled under its
  own token; there's no path to a stranger's device.
- **Per-instance rate limits** on `/notify` and `/enroll` (`lib/ratelimit.ts`) cap
  volume, cost, and abuse from a leaked token.
- **Recovery** — instance reset (Mantle-side) invalidates all old routing tokens.

TOFU registration is sound because the instance token is a 256-bit secret:
unguessable, first-registrant-claims, and incapable of reaching anyone else's
devices.

---

## 11. Operational architecture

- **Deployment (interim):** co-located on the Mantle production box as its own
  compose stack (`mantle_push` + `mantle_push_db`), joined to Mantle's Docker
  network so the existing **Caddy** reverse-proxies `push.crossworks.network` →
  `push:8787` (TLS auto-issued). No host ports published. See [`deploy.md`](deploy.md).
- **Transparent relocation:** clients only ever know the `relay_url` (DNS), so
  moving to a dedicated VPS later is a DNS repoint — no token or client change.
  (That move also isolates the APNs/FCM creds off the prod box — the main reason
  to do it.)
- **Migrations:** a tiny forward-only runner (`migrate.ts`) tracked in a
  `_migrations` table; runs before the service starts.
- **Health:** `GET /healthz` reports `{ok, provider}`; a clean `provider:"live"`
  boot is itself a credential check.

---

## 12. Design decisions & trade-offs

- **Blind relay over a trusted one** — turns the mandatory central party into a
  privacy feature; the cost is that the ends do the crypto (already true for E2E).
- **Self-generated instance token (TOFU) over a purchased key** — free, zero
  friction (one-tap Connect, nothing to paste), and safe because of the bounded
  blast radius. Optional later hardening: bind an instance to a verified email or
  a signed build attestation.
- **Build, don't buy** the relay — it's a few hundred lines (APNs HTTP/2 + JWT,
  FCM v1, one Postgres table, rate limits); APNs/FCM sends are free, so the only
  cost is a tiny always-on service. A bought relay (OneSignal/Pusher) stays a
  fallback — they'd see only ciphertext anyway.
- **Own Postgres over sharing Mantle's** — keeps relay metadata off the brain DB
  and matches the eventual move to a separate VPS.
- **Run TS directly (no build)** — fewer moving parts for a small service; the
  trade-off is avoiding a few TS features Node's stripper rejects.
- **In-memory rate limiter** — fine for the single-process MVP; a multi-replica
  deploy moves it to Redis.

### Future seams (designed-in, not built)
- **Paid tier:** add `plan / status / expires_at` to `instances` and check it in
  `/enroll` + `/notify`; flip via a billing webhook. No other change.
- **Self-hosting the relay:** the wire protocol is documented and the service is
  MIT — a power user can run their own (though self-hosting *iOS* push still needs
  their own Apple account + a rebuild with their bundle id, which is the friction
  the hosted relay exists to absorb).

---

_See also: [`README.md`](../README.md) · [`deploy.md`](deploy.md) · the product
design in [`push-notifications.md`](../../mantle-companion/docs/push-notifications.md)._
