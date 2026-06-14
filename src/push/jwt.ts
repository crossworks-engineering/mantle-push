// Minimal JWT signing for the two push providers — no dependency, just
// node:crypto. APNs uses ES256 (the .p8 EC key); FCM's OAuth grant uses RS256
// (the service-account RSA key).

import { createSign } from 'node:crypto';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function encodeSegment(value: unknown): string {
  return b64url(JSON.stringify(value));
}

/** ES256 (ECDSA P-256 + SHA-256) — used for the APNs provider token. */
export function signEs256(claims: Record<string, unknown>, keyId: string, p8Pem: string): string {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  // dsaEncoding 'ieee-p1363' → raw r||s (64 bytes), as JWS requires (not DER).
  const sig = createSign('SHA256')
    .update(signingInput)
    .sign({ key: p8Pem, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

/** RS256 (RSA + SHA-256) — used for the FCM service-account OAuth grant. */
export function signRs256(claims: Record<string, unknown>, privateKeyPem: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(sig)}`;
}
