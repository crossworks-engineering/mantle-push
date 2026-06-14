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

Add an override that attaches this repo's services to Mantle's network
(`mantle_default`) and runs in `live` mode with the real credentials:

```yaml
# docker-compose.prod.yml (on the prod box, next to this repo)
services:
  push:
    environment:
      PUSH_PROVIDER: live
      APNS_KEY_ID: ${APNS_KEY_ID}
      APNS_TEAM_ID: ${APNS_TEAM_ID}
      APNS_KEY_PATH: /run/secrets/apns.p8
      APNS_ENV: production
      FCM_PROJECT_ID: ${FCM_PROJECT_ID}
      FCM_SERVICE_ACCOUNT_PATH: /run/secrets/fcm.json
    volumes:
      - ./secrets/apns.p8:/run/secrets/apns.p8:ro
      - ./secrets/fcm.json:/run/secrets/fcm.json:ro
    networks:
      - default        # this stack's own net (reaches db)
      - mantle         # Mantle's net, so Caddy can reach `push`
    ports: []          # no public port — only Caddy reaches it

networks:
  mantle:
    external: true
    name: mantle_default
```

Then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose exec push node src/migrate.ts   # first deploy only
```

Caddy (already on `mantle_default`) now proxies `push.crossworks.network` →
`push:8787`.

## Credentials needed before `live`

- **APNs**: an Apple Developer account, a `.p8` token key (`APNS_KEY_ID`,
  `APNS_TEAM_ID`), and the app's bundle id as `APNS_TOPIC`. Use `APNS_ENV=sandbox`
  for development/TestFlight-debug builds, `production` for the store/release.
- **FCM**: a Firebase project, a service-account JSON (`FCM_PROJECT_ID` +
  the key file).

These don't exist yet — M1 is fully verifiable in `mock` mode without them. They
become required at **M3/M4** (the iOS/Android app work), which is when the relay
flips to `live`.

## Smoke-test a live deploy

```bash
curl -s https://push.crossworks.network/healthz        # {"ok":true,"provider":"live"}
# then run scripts/smoke.ts with BASE_URL set — but note it uses the mock
# assertion on /healthz; against live, register/enroll/notify still work, though
# /notify will attempt a real APNs/FCM send to the (fake) token and return 502.
```

For a real end-to-end test you need a device-issued OS push token (M3+).
