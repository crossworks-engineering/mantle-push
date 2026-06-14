# Mantle Push

A **blind, end-to-end-encrypted push relay** for the [Mantle
Companion](../mantle-companion) app. It holds the store app's Apple (APNs) and
Google (FCM) push credentials — the one thing a self-hosted Mantle backend
physically cannot — and forwards **opaque ciphertext** to the right device. It
never sees notification content, the Mantle URL, or any private key.

> Full design + rationale: [`../mantle-companion/docs/push-notifications.md`](../mantle-companion/docs/push-notifications.md).
> This repo is **M1** of that plan: the relay MVP.

MIT-licensed and self-hostable. The hosted instance runs at
`https://push.crossworks.network`.

## Why a central relay at all

A store-distributed app has **one** bundle id and **one** set of push
credentials, held by the publisher. Only the holder of the APNs key can deliver
to the app — so each self-hosted Mantle backend can't push on its own. Mantle
Push is that credential-holder, made **blind**: every payload is a libsodium
sealed box the relay can't open. Compromising the relay leaks routing metadata
(which device, when, size) — never message bodies.

## How it works (the spine)

```
Mantle backend  --/instances-->  Mantle Push          (TOFU: claim an install)
   (self-hosted)                   (this service)
App  --enrollment ticket-->  /enroll  -->  routing token   (per device)
Mantle  --Bearer instance token-->  /notify {routingToken, ciphertext}
                                          |
                                          v
                                    APNs / FCM  -->  device decrypts in NSE/handler
```

- **Instance token** — a 256-bit secret the user's Mantle self-generates and
  registers (trust-on-first-use). Authenticates `/notify`. We store only its
  SHA-256 hash.
- **Enrollment ticket** — short-lived (~5 min), HMAC-signed by the instance
  token, binds one device's OS push token. Lets the app enroll without ever
  holding the long-lived secret.
- **Routing token** — opaque per-device handle the relay mints at enrollment;
  Mantle sends to it. Stored hashed.

An instance can **only** push to devices enrolled under its own token, so a
self-claimed free token is safe (see the design doc §12).

## API

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `POST` | `/instances` | instance token (body) | `{instanceToken}` | `{instanceId}` |
| `POST` | `/enroll` | enrollment ticket (body) | `{ticket, platform, osPushToken, publicKeyFingerprint?, label?}` | `{routingToken, deviceId}` |
| `POST` | `/notify` | instance token (Bearer) | `{routingToken, ciphertext, collapseKey?, priority?}` | `{ok:true}` · `410` if device dead |
| `POST` | `/refresh` | routing token (Bearer) | `{osPushToken}` | `{ok:true}` |
| `DELETE` | `/device` | routing **or** instance token (Bearer) | `{routingToken}` (instance path) | `{ok:true}` |
| `GET` | `/instance` | instance token (Bearer) | — | `{instanceId, devices:[…metadata]}` |
| `GET` | `/healthz` | — | — | `{ok:true, provider}` |

`ciphertext` is base64 of a libsodium `crypto_box_seal` blob — opaque to the
relay. `/notify` and `/enroll` are rate-limited per instance.

## Run it locally

```bash
pnpm install
docker compose up -d db            # its own Postgres on :5544 (isolated from Mantle's)
pnpm migrate                       # apply migrations/0001_init.sql
pnpm dev                           # PUSH_PROVIDER=mock by default — no Apple/Google creds needed
pnpm smoke                         # end-to-end: register → enroll → notify → … (14 checks)
```

`pnpm typecheck` runs `tsc --noEmit`. The service runs TypeScript directly via
Node's native type-stripping (Node ≥ 22.6) — there's no build step. (Avoid
TS features strip-mode rejects: enums, namespaces, constructor parameter
properties.)

### Provider modes

- **`mock`** (default) — logs each "delivery" and succeeds. The whole spine is
  verifiable from the CLI with no credentials.
- **`live`** — real APNs (HTTP/2 + ES256 `.p8` JWT) and FCM v1 (RS256
  service-account OAuth). Set the credentials in `.env` (see `.env.example`);
  the server refuses to start in `live` mode if any are missing.

## Layout

```
src/
  index.ts        server bootstrap (listen + graceful shutdown)
  app.ts          Hono app — all routes, auth, rate limits
  config.ts       env validation (fail-fast)
  db.ts           pg pool
  migrate.ts      forward-only migration runner
  lib/
    tokens.ts     generate / sha256-hash / constant-time compare
    ticket.ts     mint + verify enrollment tickets (HMAC)
    store.ts      the only module that touches SQL
    ratelimit.ts  per-instance fixed-window limiter
  push/
    index.ts      provider selection + per-platform dispatch
    apns.ts       APNs HTTP/2 + JWT
    fcm.ts        FCM v1 + OAuth
    mock.ts       credential-less local provider
    jwt.ts        ES256 / RS256 signing (node:crypto, no deps)
migrations/0001_init.sql
scripts/smoke.ts  end-to-end CLI test
```

## Deploy

See [`docs/deploy.md`](docs/deploy.md). Interim: co-located on the prod box
behind the existing Caddy, at `push.crossworks.network`. Moves to its own VPS at
the first real client — a transparent DNS repoint (clients only ever know the
relay URL).
