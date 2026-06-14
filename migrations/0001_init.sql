-- Mantle Push initial schema.
--
-- Note the ABSENCES (push-notifications.md §7.2): no private keys, no message
-- bodies, no plaintext titles, no Mantle URL. The relay stores only routing
-- metadata. Tokens are stored as SHA-256 hashes — a DB leak can't be replayed
-- as a bearer credential.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- One row per Mantle install (one self-hosted backend). Claimed trust-on-first-
-- use: whoever first presents an unguessable 256-bit instance token owns it.
CREATE TABLE IF NOT EXISTS instances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_token_hash bytea NOT NULL UNIQUE,        -- sha256(instanceToken)
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now()
  -- plan / status / expires_at land here only when a paid tier ships (§11).
);

-- One row per enrolled device under an install.
CREATE TABLE IF NOT EXISTS devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id         uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('ios', 'android')),
  os_push_token       text NOT NULL,                -- APNs/FCM token; rotates
  routing_token_hash  bytea NOT NULL UNIQUE,        -- sha256(routingToken)
  pubkey_fingerprint  text,                          -- optional, for the device list
  label               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_push_at        timestamptz
);

CREATE INDEX IF NOT EXISTS devices_instance_idx ON devices (instance_id);
