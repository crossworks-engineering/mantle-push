// Central, validated config read once at boot. Throws early on a bad/missing
// value rather than failing deep inside a request.

import { readFileSync } from 'node:fs';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}

// Read a secret that may be supplied inline (preferred for containers/secrets
// managers) or as a file path. Returns undefined if neither is set.
function fileOrInline(inlineVar: string, pathVar: string): string | undefined {
  const inline = process.env[inlineVar];
  if (inline && inline.trim() !== '') return inline;
  const path = process.env[pathVar];
  if (path && path.trim() !== '') {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined; // missing file → treated as "not configured"
    }
  }
  return undefined;
}

export type ProviderMode = 'mock' | 'live';

const provider = env('PUSH_PROVIDER', 'mock') as ProviderMode;
if (provider !== 'mock' && provider !== 'live') {
  throw new Error(`PUSH_PROVIDER must be "mock" or "live", got "${provider}"`);
}

export const config = {
  port: intEnv('PORT', 8787),
  databaseUrl: env('DATABASE_URL', 'postgres://push:push@localhost:5544/mantle_push'),
  provider,

  apns: {
    topic: env('APNS_TOPIC', 'network.crossworks.mantle'),
    keyId: process.env.APNS_KEY_ID ?? '',
    teamId: process.env.APNS_TEAM_ID ?? '',
    key: fileOrInline('APNS_KEY_P8', 'APNS_KEY_PATH'),
    production: (process.env.APNS_ENV ?? 'sandbox') === 'production',
  },

  fcm: {
    projectId: process.env.FCM_PROJECT_ID ?? '',
    serviceAccount: fileOrInline('FCM_SERVICE_ACCOUNT', 'FCM_SERVICE_ACCOUNT_PATH'),
  },

  rate: {
    notifyPerMin: intEnv('RATE_NOTIFY_PER_MIN', 60),
    enrollPerMin: intEnv('RATE_ENROLL_PER_MIN', 10),
  },
} as const;

// Fail fast: in live mode, the credentials a platform needs must be present.
export function assertLiveCredentials(): void {
  if (config.provider !== 'live') return;
  const missing: string[] = [];
  if (!config.apns.keyId || !config.apns.teamId || !config.apns.key) {
    missing.push('APNs (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8/PATH)');
  }
  if (!config.fcm.projectId || !config.fcm.serviceAccount) {
    missing.push('FCM (FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT/PATH)');
  }
  if (missing.length) {
    throw new Error(
      `PUSH_PROVIDER=live but credentials are missing: ${missing.join('; ')}. ` +
        `Set them, or run with PUSH_PROVIDER=mock.`,
    );
  }
}
