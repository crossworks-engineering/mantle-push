// Data access for instances + devices. The only module that touches SQL.
// Tokens enter as raw strings and are hashed here before they hit the DB.

import { query } from '../db.ts';
import { generateToken, hashToken } from './tokens.ts';
import type { Platform } from '../push/types.ts';

export interface InstanceRow {
  id: string;
  instance_token_hash: Buffer;
}

export interface DeviceRow {
  id: string;
  instance_id: string;
  platform: Platform;
  os_push_token: string;
}

export interface DeviceMeta {
  id: string;
  platform: Platform;
  label: string | null;
  pubkey_fingerprint: string | null;
  created_at: string;
  last_seen_at: string;
  last_push_at: string | null;
}

/** TOFU register/claim. Idempotent: re-presenting the token returns the same id. */
export async function claimInstance(instanceToken: string): Promise<string> {
  const hash = hashToken(instanceToken);
  const res = await query<{ id: string }>(
    `INSERT INTO instances (instance_token_hash) VALUES ($1)
       ON CONFLICT (instance_token_hash)
       DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [hash],
  );
  return res.rows[0]!.id;
}

export async function findInstanceByToken(instanceToken: string): Promise<InstanceRow | null> {
  const res = await query<InstanceRow>(
    `UPDATE instances SET last_seen_at = now()
       WHERE instance_token_hash = $1
     RETURNING id, instance_token_hash`,
    [hashToken(instanceToken)],
  );
  return res.rows[0] ?? null;
}

export async function findInstanceById(id: string): Promise<InstanceRow | null> {
  const res = await query<InstanceRow>(
    `SELECT id, instance_token_hash FROM instances WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Create a device row; returns the raw routing token (stored only as a hash). */
export async function createDevice(args: {
  instanceId: string;
  platform: Platform;
  osPushToken: string;
  pubkeyFingerprint?: string | null;
  label?: string | null;
}): Promise<{ id: string; routingToken: string }> {
  const routingToken = generateToken();
  const res = await query<{ id: string }>(
    `INSERT INTO devices (instance_id, platform, os_push_token, routing_token_hash, pubkey_fingerprint, label)
       VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      args.instanceId,
      args.platform,
      args.osPushToken,
      hashToken(routingToken),
      args.pubkeyFingerprint ?? null,
      args.label ?? null,
    ],
  );
  return { id: res.rows[0]!.id, routingToken };
}

export async function findDeviceByRoutingToken(routingToken: string): Promise<DeviceRow | null> {
  const res = await query<DeviceRow>(
    `SELECT id, instance_id, platform, os_push_token FROM devices WHERE routing_token_hash = $1`,
    [hashToken(routingToken)],
  );
  return res.rows[0] ?? null;
}

export async function refreshDeviceToken(routingToken: string, osPushToken: string): Promise<boolean> {
  const res = await query(
    `UPDATE devices SET os_push_token = $2, last_seen_at = now() WHERE routing_token_hash = $1`,
    [hashToken(routingToken), osPushToken],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteDeviceByRoutingToken(routingToken: string): Promise<boolean> {
  const res = await query(`DELETE FROM devices WHERE routing_token_hash = $1`, [hashToken(routingToken)]);
  return (res.rowCount ?? 0) > 0;
}

/** Unpair a device by routing token, scoped to an instance (instance-token auth path). */
export async function deleteDeviceForInstance(instanceId: string, routingToken: string): Promise<boolean> {
  const res = await query(
    `DELETE FROM devices WHERE routing_token_hash = $1 AND instance_id = $2`,
    [hashToken(routingToken), instanceId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteDeviceById(id: string): Promise<void> {
  await query(`DELETE FROM devices WHERE id = $1`, [id]);
}

export async function markDevicePushed(id: string): Promise<void> {
  await query(`UPDATE devices SET last_push_at = now() WHERE id = $1`, [id]);
}

export async function listDevices(instanceId: string): Promise<DeviceMeta[]> {
  const res = await query<DeviceMeta>(
    `SELECT id, platform, label, pubkey_fingerprint, created_at, last_seen_at, last_push_at
       FROM devices WHERE instance_id = $1 ORDER BY created_at`,
    [instanceId],
  );
  return res.rows;
}
