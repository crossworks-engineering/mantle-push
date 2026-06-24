// Unit tests for enrollment tickets — the anti-forgery boundary. A ticket is an
// HMAC-SHA256 grant keyed by sha256(instanceToken); the relay verifies against
// the stored instance_token_hash without ever holding the raw secret, and the
// app (which only sees a finished ticket) must not be able to forge or extend
// one. These tests pin: round-trip, expiry (incl. boundary), wrong-key,
// signature tampering, payload tampering (exp extension), cross-instance
// forgery, and every malformed shape. Run: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintTicket, verifyTicket, decodeTicketPayload } from './ticket.ts';
import { hashToken } from './tokens.ts';

const IID = '11111111-2222-3333-4444-555555555555';
const OS_TOKEN = 'apns-device-token-abc123';
const INSTANCE_TOKEN = 'instance-secret-token';
const HASH = hashToken(INSTANCE_TOKEN);

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('round-trip: a freshly minted ticket verifies and returns its payload', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now);
  const verdict = verifyTicket(ticket, HASH, now);
  assert.ok(verdict.ok, 'should verify');
  assert.deepEqual(verdict.payload, { iid: IID, osPushToken: OS_TOKEN, exp: now + 300 });
});

test('mintTicket: default TTL is 300s; custom ttlSeconds honoured', () => {
  const now = 50_000;
  const def = decodeTicketPayload(mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now));
  assert.equal(def?.exp, now + 300);

  const custom = decodeTicketPayload(
    mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN, ttlSeconds: 60 }, now),
  );
  assert.equal(custom?.exp, now + 60);
});

test('mintTicket: wire format is <base64url>.<base64url>', () => {
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, 0);
  assert.match(ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(ticket.split('.').length, 2);
});

test('expiry: rejected once now passes exp, accepted up to and including exp', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now); // exp = now+300
  const exp = now + 300;

  assert.ok(verifyTicket(ticket, HASH, exp - 1).ok, 'valid one second before exp');
  assert.ok(verifyTicket(ticket, HASH, exp).ok, 'valid exactly at exp (now > exp is strict)');

  const expired = verifyTicket(ticket, HASH, exp + 1);
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.reason, 'expired');
});

test('wrong key: a ticket does not verify against a different instance hash', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now);
  const verdict = verifyTicket(ticket, hashToken('a-different-instance-token'), now);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
});

test('cross-instance forgery: instance A cannot mint a ticket that verifies for instance B', () => {
  const now = 1_000_000;
  const ticketFromA = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: 'token-A' }, now);
  const verdict = verifyTicket(ticketFromA, hashToken('token-B'), now);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
});

test('tampered signature: flipping the sig is rejected as bad_signature', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now);
  const tampered = ticket.slice(0, -2) + (ticket.endsWith('AA') ? 'BB' : 'AA');
  const verdict = verifyTicket(tampered, HASH, now);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
});

test('payload tampering: extending exp under the original signature fails (no replay-extension)', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now);
  const [, sig] = ticket.split('.');
  // Attacker rewrites the payload to a far-future exp but keeps the old sig.
  const forgedPayload = b64urlJson({ iid: IID, osPushToken: OS_TOKEN, exp: now + 10_000_000 });
  const forged = `${forgedPayload}.${sig}`;

  const verdict = verifyTicket(forged, HASH, now);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
});

test('payload tampering: swapping osPushToken under the original signature fails', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now);
  const [, sig] = ticket.split('.');
  const forgedPayload = b64urlJson({ iid: IID, osPushToken: 'attacker-device-token', exp: now + 300 });
  const verdict = verifyTicket(`${forgedPayload}.${sig}`, HASH, now);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'bad_signature');
});

test('signature check precedes expiry: an expired ticket with a valid sig reports expired, not bad_signature', () => {
  const now = 1_000_000;
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, now);
  const verdict = verifyTicket(ticket, HASH, now + 10_000);
  assert.equal(verdict.ok === false && verdict.reason, 'expired');
});

// --- malformed shapes -------------------------------------------------------

test('malformed: no dot separator', () => {
  const v = verifyTicket('no-dot-here', HASH, 0);
  assert.equal(v.ok === false && v.reason, 'malformed');
});

test('malformed: leading dot (empty payload segment)', () => {
  const v = verifyTicket('.somesig', HASH, 0);
  assert.equal(v.ok === false && v.reason, 'malformed');
});

test('malformed: empty string', () => {
  const v = verifyTicket('', HASH, 0);
  assert.equal(v.ok === false && v.reason, 'malformed');
});

test('malformed: payload segment is not valid JSON', () => {
  // '!!!' is outside the base64url alphabet → decodes to empty → JSON.parse throws.
  const v = verifyTicket('!!!.somesig', HASH, 0);
  assert.equal(v.ok === false && v.reason, 'malformed');
});

test('malformed: payload JSON missing a required field', () => {
  const payload = b64urlJson({ iid: IID, osPushToken: OS_TOKEN }); // no exp
  const v = verifyTicket(`${payload}.somesig`, HASH, 0);
  assert.equal(v.ok === false && v.reason, 'malformed');
});

test('malformed: payload JSON with a wrong-typed field', () => {
  const payload = b64urlJson({ iid: IID, osPushToken: OS_TOKEN, exp: 'not-a-number' });
  const v = verifyTicket(`${payload}.somesig`, HASH, 0);
  assert.equal(v.ok === false && v.reason, 'malformed');
});

// --- decodeTicketPayload (unverified read used to look up iid) ---------------

test('decodeTicketPayload: returns the payload for a well-formed ticket', () => {
  const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN }, 7);
  assert.deepEqual(decodeTicketPayload(ticket), { iid: IID, osPushToken: OS_TOKEN, exp: 307 });
});

test('decodeTicketPayload: null on no dot / wrong types / missing fields / garbage', () => {
  assert.equal(decodeTicketPayload('nodot'), null);
  assert.equal(decodeTicketPayload('.x'), null);
  assert.equal(decodeTicketPayload('!!!.x'), null);
  assert.equal(decodeTicketPayload(`${b64urlJson({ iid: 1, osPushToken: OS_TOKEN, exp: 1 })}.x`), null); // iid not string
  assert.equal(decodeTicketPayload(`${b64urlJson({ osPushToken: OS_TOKEN, exp: 1 })}.x`), null); // no iid
});
