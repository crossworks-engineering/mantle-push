// Unit tests for the opaque-bearer-token primitives. Security-critical: these
// back instance/routing tokens and their at-rest hashing, so we pin the exact
// byte lengths, encoding, determinism, and the length-guarded constant-time
// compare. Run: `node --test` (or `pnpm test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateToken, hashToken, safeEqual } from './tokens.ts';

test('generateToken: 256-bit, URL-safe, unpadded base64url', () => {
  const t = generateToken();
  // 32 raw bytes round-trips back to 32 bytes.
  assert.equal(Buffer.from(t, 'base64url').length, 32);
  // base64url of 32 bytes is 43 chars with no '=' padding.
  assert.equal(t.length, 43);
  // URL-safe alphabet only: no '+', '/', or '='.
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('generateToken: produces unique values (no collisions across 5000 draws)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(generateToken());
  assert.equal(seen.size, 5000);
});

test('hashToken: matches known SHA-256 vectors (utf8 input)', () => {
  // FIPS 180-4 / standard test vectors.
  assert.equal(
    hashToken('').toString('hex'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    hashToken('abc').toString('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('hashToken: returns 32 raw bytes and is deterministic', () => {
  const tok = generateToken();
  const a = hashToken(tok);
  const b = hashToken(tok);
  assert.equal(a.length, 32);
  assert.ok(a.equals(b), 'same input must hash identically');
});

test('hashToken: distinct inputs produce distinct hashes', () => {
  assert.ok(!hashToken('token-a').equals(hashToken('token-b')));
});

test('hashToken: agrees with a fresh node:crypto sha256 (no hidden transform)', () => {
  const tok = generateToken();
  const reference = createHash('sha256').update(tok, 'utf8').digest();
  assert.ok(hashToken(tok).equals(reference));
});

test('safeEqual: true for identical buffers', () => {
  const a = hashToken('same');
  const b = hashToken('same');
  assert.equal(safeEqual(a, b), true);
});

test('safeEqual: true for two empty buffers', () => {
  assert.equal(safeEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
});

test('safeEqual: false for equal-length but differing buffers', () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 5]);
  assert.equal(safeEqual(a, b), false);
});

test('safeEqual: false (no throw) on length mismatch', () => {
  // The length guard exists precisely because timingSafeEqual throws on
  // differing lengths — this is the regression that guard prevents.
  const short = Buffer.from([1, 2, 3]);
  const long = Buffer.from([1, 2, 3, 4]);
  assert.doesNotThrow(() => safeEqual(short, long));
  assert.equal(safeEqual(short, long), false);
  assert.equal(safeEqual(long, short), false);
});
