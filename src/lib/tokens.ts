// Opaque bearer tokens (instance + routing) and their at-rest hashing.
//
// Tokens are 256-bit, base64url, unguessable. We store only their SHA-256 hash:
// a DB leak yields hashes, not usable credentials. Lookups hash the presented
// token and match on the hash column (which is UNIQUE/indexed).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A fresh 256-bit secret, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256(token) as raw bytes — what we persist and look up by. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time compare of two same-length buffers (false on length mismatch). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
