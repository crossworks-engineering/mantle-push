// APNs provider — HTTP/2 to Apple, token-based auth (.p8 → ES256 JWT).
// The ciphertext rides in a custom data key; `mutable-content: 1` hands the
// push to the app's Notification Service Extension, which decrypts and rewrites
// the alert before display (push-notifications.md §6). No plaintext here.

import http2 from 'node:http2';
import { signEs256 } from './jwt.ts';
import type { DeliveryResult, PushMessage, PushProvider, PushTarget } from './types.ts';

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
// Apple requires the provider token be refreshed every 20–60 min; reuse within.
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface ApnsConfig {
  topic: string;
  keyId: string;
  teamId: string;
  keyP8: string;
  production: boolean;
}

export function createApnsProvider(cfg: ApnsConfig): PushProvider {
  const host = cfg.production ? PROD_HOST : SANDBOX_HOST;
  let session: http2.ClientHttp2Session | null = null;
  let cachedToken: { jwt: string; mintedAt: number } | null = null;

  function providerToken(): string {
    const now = Date.now();
    if (cachedToken && now - cachedToken.mintedAt < TOKEN_TTL_MS) return cachedToken.jwt;
    const jwt = signEs256({ iss: cfg.teamId, iat: Math.floor(now / 1000) }, cfg.keyId, cfg.keyP8);
    cachedToken = { jwt, mintedAt: now };
    return jwt;
  }

  function getSession(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(host);
    session.on('error', () => {
      session?.destroy();
      session = null;
    });
    return session;
  }

  async function send(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    // A visible alert is required for mutable-content to invoke the NSE; the
    // placeholder text is replaced on-device after decryption.
    const body = JSON.stringify({
      aps: { 'mutable-content': 1, alert: { body: 'Encrypted notification' }, sound: 'default' },
      ct: message.ciphertext,
    });

    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${target.osPushToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      'apns-priority': message.priority === 'normal' ? '5' : '10',
    };
    if (message.collapseKey) headers['apns-collapse-id'] = message.collapseKey.slice(0, 64);

    return new Promise<DeliveryResult>((resolve) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = getSession().request(headers);
      } catch (err) {
        resolve({ ok: false, status: 0, reason: `connect_failed: ${(err as Error).message}` });
        return;
      }
      let status = 0;
      const chunks: Buffer[] = [];
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('error', (err) => resolve({ ok: false, status, reason: `stream_error: ${err.message}` }));
      req.on('end', () => {
        if (status === 200) {
          resolve({ ok: true });
          return;
        }
        let reason = `apns_${status}`;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string };
          if (parsed.reason) reason = parsed.reason;
        } catch {
          /* non-JSON body */
        }
        // 410 Gone, or 400 BadDeviceToken / Unregistered → token is dead.
        const unregistered = status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';
        resolve({ ok: false, status, reason, unregistered });
      });
      // NB: do NOT setEncoding('utf8') here — the `data` handler collects Buffers
      // for Buffer.concat below; switching to string chunks makes that throw
      // (swallowed), losing the APNs reason and misreporting as bare "apns_<n>".
      req.end(body);
    });
  }

  async function close(): Promise<void> {
    session?.close();
    session = null;
  }

  return { name: 'apns', send, close };
}
