# Deploying Mantle Push

_Status: **LIVE on its own dedicated VPS** at `https://push.crossworks.network`._

Mantle Push runs on its **own small VPS** — isolated from any Mantle backend, so
the APNs `.p8` + FCM service-account creds live nowhere else. Clients only ever
know the relay URL, so the host can move with a transparent DNS repoint (no token
or client change). It originally co-located on the Mantle prod box behind that
box's Caddy; it moved to a dedicated box on 2026-06-23 (see the migration note at
the bottom).

## Shape: self-contained stack (relay + Postgres + its own Caddy)

The box runs three containers from this repo's compose, on an internal network —
nothing is published to the host except Caddy's 80/443:

| Container | Role |
|---|---|
| `mantle_push_caddy` | terminates TLS (auto Let's Encrypt for `push.crossworks.network`), proxies to `push:8787` |
| `mantle_push` | the relay (Node, TS via type-stripping, no build step) |
| `mantle_push_db` | the relay's own Postgres (`instances` + `devices`) |

- `docker-compose.yml` — base (relay + db).
- `docker-compose.vps.yml` — VPS overlay: adds Caddy, drops host port publishing,
  mounts the secret files, sets `restart: unless-stopped`. Config (Caddy site
  block) is `infra/Caddyfile`.

## Prerequisites on the box

- Docker + Compose v2.
- DNS `push.crossworks.network` → the box's public IP, ports 80/443 open (Caddy
  needs 80 reachable for the ACME HTTP-01 challenge).
- The two secret files in `./secrets/` (gitignored):

| File | Mounts as | Source |
|---|---|---|
| `AuthKey.p8` | `/run/secrets/apns.p8` | the APNs token-auth key (one-time download) |
| `fcm-service-account.json` | `/run/secrets/fcm-service-account.json` | Firebase → Project settings → Service accounts → Generate new private key |

- A gitignored `.env` next to the compose files (compose auto-loads it):

```bash
PUSH_PROVIDER=live                        # the relay refuses to boot in live mode if a cred is missing
APNS_TOPIC=crossworks.engineering.mantle  # the registered bundle id
APNS_KEY_ID=...
APNS_TEAM_ID=...
APNS_ENV=production                       # the topic-specific key is production-only
FCM_PROJECT_ID=...
```

## Deploy / redeploy

```bash
# from a workstation: sync the repo (never the secrets/.env — they live on the box)
rsync -a --delete \
  --exclude node_modules/ --exclude .git/ --exclude .env --exclude secrets/ \
  --exclude backups/ ./ cwe@push.crossworks.network:~/mantle-push/

# on the box:
cd ~/mantle-push
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

Caddy auto-issues the TLS cert on the first request. The relay runs migrations on
start (`node src/migrate.ts`) then serves.

## Smoke-test a live deploy

```bash
curl -s https://push.crossworks.network/healthz        # {"ok":true,"provider":"live"}
BASE_URL=https://push.crossworks.network node scripts/smoke-live.ts
```

`smoke-live.ts` registers a throwaway instance, enrolls a fake iOS + Android
token, and `/notify`s each. Without a real device you still prove the creds
authenticate: APNs returns **`BadDeviceToken`** (relay → `410`) = our ES256 `.p8`
JWT was accepted (a creds failure would be `InvalidProviderToken`); FCM returns
**`INVALID_ARGUMENT`** = the service-account OAuth succeeded. Delete the test
instance row afterward so the DB stays clean.

---

## Migration note — co-located → dedicated VPS (2026-06-23)

The relay moved off the Mantle prod box (`jason.crossworks.network`) to a
dedicated box (`push.crossworks.network` → its own IP). The cutover:

1. Stood up the self-contained stack here (compose above), restoring a `pg_dump`
   of the relay DB so the registered instance row carried over (transparent — the
   Mantle backend reaches the relay by its stored public `relayUrl`, which just
   follows DNS).
2. Verified `healthz` + `smoke-live` against the new box.
3. On the old box: `docker compose ... down`, removed the
   `push.crossworks.network` site block from Mantle's Caddyfile + `caddy reload`,
   and deleted `~/mantle-push` (including its secrets) and the DB volume.

This retired the co-location caveat: the push creds no longer live on a Mantle
backend. The old `docker-compose.prod.yml` (which joined Mantle's network and
borrowed its Caddy) is gone — `docker-compose.vps.yml` replaces it.
