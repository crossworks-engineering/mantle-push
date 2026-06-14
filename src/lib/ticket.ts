// Enrollment tickets — a short-lived, instance-signed grant that lets the app
// enroll a device WITHOUT ever holding the long-lived instance token
// (push-notifications.md §5.1).
//
// Wire format (compact, URL-safe):  <base64url(payloadJSON)>.<base64url(hmac)>
//   payload = { iid, osPushToken, exp }   (exp = unix seconds)
//   hmac    = HMAC-SHA256( payloadB64, key = sha256(instanceToken) )
//
// Why key = sha256(instanceToken): Mantle holds the raw token and derives the
// key; the relay stores exactly that sha256 (instance_token_hash) and derives
// the SAME key — so the relay verifies without holding the raw secret, and the
// app (which only ever sees a finished ticket) cannot forge new ones.

import { createHmac } from 'node:crypto';
import { hashToken, safeEqual } from './tokens.ts';

export interface TicketPayload {
  iid: string; // instance id (uuid) the relay can look up
  osPushToken: string; // binds the ticket to one device's push token
  exp: number; // unix seconds; relay rejects when now > exp
}

const DEFAULT_TTL_SECONDS = 300; // ~5 min

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payloadB64: string, ticketKey: Buffer): string {
  return createHmac('sha256', ticketKey).update(payloadB64).digest('base64url');
}

/**
 * Mint a ticket. Used by Mantle (and the smoke CLI standing in for it), which
 * holds the raw instance token. `nowSeconds` is injectable for tests.
 */
export function mintTicket(
  args: { iid: string; osPushToken: string; instanceToken: string; ttlSeconds?: number },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const exp = nowSeconds + (args.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: TicketPayload = { iid: args.iid, osPushToken: args.osPushToken, exp };
  const payloadB64 = b64urlJson(payload);
  const sig = sign(payloadB64, hashToken(args.instanceToken));
  return `${payloadB64}.${sig}`;
}

/** Parse the payload WITHOUT verifying — used to read `iid` before lookup. */
export function decodeTicketPayload(ticket: string): TicketPayload | null {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  try {
    const json = Buffer.from(ticket.slice(0, dot), 'base64url').toString('utf8');
    const p = JSON.parse(json) as Partial<TicketPayload>;
    if (typeof p.iid !== 'string' || typeof p.osPushToken !== 'string' || typeof p.exp !== 'number') {
      return null;
    }
    return { iid: p.iid, osPushToken: p.osPushToken, exp: p.exp };
  } catch {
    return null;
  }
}

export type TicketVerdict =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a ticket against the instance's stored token hash (the relay's side).
 * `instanceTokenHash` is the `instance_token_hash` column for `payload.iid`.
 */
export function verifyTicket(
  ticket: string,
  instanceTokenHash: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TicketVerdict {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);

  const payload = decodeTicketPayload(ticket);
  if (!payload) return { ok: false, reason: 'malformed' };

  const expected = sign(payloadB64, instanceTokenHash);
  // Compare raw bytes in constant time.
  if (!safeEqual(Buffer.from(sigB64, 'base64url'), Buffer.from(expected, 'base64url'))) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (nowSeconds > payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
