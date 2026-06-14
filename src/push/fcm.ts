// FCM (Firebase Cloud Messaging) v1 provider — Android.
// Sends a DATA-ONLY message (no `notification` key) so the app's background
// handler always runs to decrypt and post a local notification (§9.2). Auth is
// an OAuth2 access token minted from the service-account key (RS256 JWT grant).

import { signRs256 } from './jwt.ts';
import type { DeliveryResult, PushMessage, PushProvider, PushTarget } from './types.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface FcmConfig {
  projectId: string;
  serviceAccountJson: string;
}

export function createFcmProvider(cfg: FcmConfig): PushProvider {
  const sa = JSON.parse(cfg.serviceAccountJson) as ServiceAccount;
  const projectId = cfg.projectId || sa.project_id || '';
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  let cachedToken: { token: string; fetchedAt: number } | null = null;

  async function accessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && now - cachedToken.fetchedAt < ACCESS_TOKEN_TTL_MS) return cachedToken.token;
    const iat = Math.floor(now / 1000);
    const assertion = signRs256(
      { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 },
      sa.private_key,
    );
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      throw new Error(`fcm oauth failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string };
    cachedToken = { token: json.access_token, fetchedAt: now };
    return json.access_token;
  }

  async function send(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    let token: string;
    try {
      token = await accessToken();
    } catch (err) {
      return { ok: false, status: 0, reason: (err as Error).message };
    }

    const payload = {
      message: {
        token: target.osPushToken,
        // Data-only — keep keys as strings (FCM requirement).
        data: { ct: message.ciphertext },
        android: {
          priority: message.priority === 'normal' ? 'NORMAL' : 'HIGH',
          ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
        },
      },
    };

    const res = await fetch(sendUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };

    const text = await res.text();
    let reason = `fcm_${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      reason = parsed.error?.status ?? parsed.error?.message ?? reason;
    } catch {
      /* non-JSON */
    }
    // UNREGISTERED / NOT_FOUND (404) → token dead.
    const unregistered = res.status === 404 || reason === 'UNREGISTERED' || reason === 'NOT_FOUND';
    return { ok: false, status: res.status, reason, unregistered };
  }

  async function close(): Promise<void> {
    /* fetch-based; nothing to tear down */
  }

  return { name: 'fcm', send, close };
}
