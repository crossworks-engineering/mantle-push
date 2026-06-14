# Deploying Mantle Push

_Status: M1 ready; **not yet deployed** (deploy is gated — ships when Jason says)._

The interim home (design doc §7) is **co-located on the Mantle prod box**, behind
the existing Caddy reverse proxy, served at `https://push.crossworks.network`.
DNS already points that host at prod. It moves to its own small VPS at the first
real client — and because clients only ever know the relay URL (DNS), that move
is a transparent repoint with no token or client change.

> ⚠️ Co-location caveat to retire on the VPS move: the APNs `.p8` + FCM creds
> then live on the prod box, so a prod compromise would also expose push creds.
> Isolating them is part of why we move.

## Shape: own compose, joined to Caddy's network

Mantle Push keeps its **own Postgres** and its own `docker-compose.yml`. On prod
it runs as a separate stack that joins Mantle's existing docker network so Caddy
can reach it by service name. Nothing in Mantle's sensitive `docker-compose.yml`
needs editing — only one additive Caddy site block.

### 1. Caddy site block (in `mantle/infra/caddy/Caddyfile`)

```caddy
push.crossworks.network {
	encode zstd gzip
	reverse_proxy push:8787
	request_body {
		max_size 64KB
	}
}
```

Caddy auto-issues the TLS cert on first request. Until the `push` upstream is
running, that host returns 502 — the main Mantle site is unaffected (upstreams
resolve lazily, per-request). **This block is already added** to the Caddyfile;
it's inert until the relay container is up on Caddy's network.

### 2. Relay stack on prod

The committed `docker-compose.prod.yml` attaches the services to Mantle's network
(`mantle_default`), drops host port publishing, and mounts the two secret files.
Its values come from a gitignored `.env` next to it on the box (compose
auto-loads it). On the prod box `~/mantle-push/.env`:

```bash
# Non-secret identifiers (registered 2026-06-14). The .p8/JSON are the secrets.
PUSH_PROVIDER=mock                      # flip to `live` once the two files are in ./secrets/
APNS_TOPIC=crossworks.engineering.mantle
APNS_KEY_ID=J65R8HBX33                  # APNs key "pushy2", team-scoped, Sandbox+Production
APNS_TEAM_ID=P6NLP32L8H
APNS_ENV=sandbox                        # sandbox for dev builds; production for TestFlight/App Store
FCM_PROJECT_ID=pusher-5bacc
```

Two secret files go in `~/mantle-push/secrets/` (the directory + `*.p8` are
gitignored):

| File | Mounts as | Source |
|---|---|---|
| `AuthKey.p8` | `/run/secrets/apns.p8` | Jason's `AuthKey_J65R8HBX33.p8` (one-time download) |
| `fcm-service-account.json` | `/run/secrets/fcm-service-account.json` | Firebase → pusher → Project settings → Service accounts → Generate new private key |

Bring it up:

```bash
cd ~/mantle-push
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Caddy (already on `mantle_default`) proxies `push.crossworks.network` → `push:8787`.

### To go live

1. `scp` the two files into `~/mantle-push/secrets/` (names exactly as the table).
2. Set `PUSH_PROVIDER=live` in `~/mantle-push/.env`.
3. Re-run the `up` command above. The relay refuses to boot in `live` mode if
   either credential is missing (fail-fast), so a clean start confirms both loaded.

## Smoke-test a live deploy

```bash
curl -s https://push.crossworks.network/healthz        # {"ok":true,"provider":"live"}
```

Without a real device token you can still prove the APNs/FCM **auth** works:
register an instance, enroll a fake OS token, and `/notify` it — APNs returns
**400 `BadDeviceToken`** (relay → `410`), which means our ES256 `.p8` JWT was
accepted (a credential error would be `403 InvalidProviderToken`). A real
end-to-end push needs a device-issued token (M3/M4).
