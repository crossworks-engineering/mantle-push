// Live-credential smoke test. Registers an instance, enrolls a FAKE iOS + a FAKE
// Android token, and /notify's each — then reads what APNs/FCM said back. With no
// real device we can still prove the CREDENTIALS authenticate:
//   - APNs: a fake token → "BadDeviceToken" means our ES256 .p8 JWT was ACCEPTED
//     (a creds failure would be "InvalidProviderToken"/403).
//   - FCM:  a fake token → an FCM-level error (UNREGISTERED/INVALID_ARGUMENT)
//     means the service-account OAuth SUCCEEDED (a creds failure says "oauth").
//
//   node scripts/smoke-live.ts            (BASE_URL defaults to prod)

import { generateToken } from '../src/lib/tokens.ts';
import { mintTicket } from '../src/lib/ticket.ts';

const BASE = process.env.BASE_URL ?? 'https://push.crossworks.network';

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

async function enroll(instanceToken: string, instanceId: string, platform: 'ios' | 'android') {
  const osPushToken = `fake-${platform}-${generateToken().slice(0, 24)}`;
  const ticket = mintTicket({ iid: instanceId, osPushToken, instanceToken });
  const res = await call('POST', '/enroll', { body: { ticket, platform, osPushToken } });
  return res.body['routingToken'] as string;
}

async function main() {
  const health = await call('GET', '/healthz');
  console.log(`healthz: provider=${health.body['provider']}`);
  if (health.body['provider'] !== 'live') {
    console.error('✗ relay is not in live mode — aborting');
    process.exit(1);
  }

  const instanceToken = generateToken();
  const reg = await call('POST', '/instances', { body: { instanceToken } });
  const instanceId = reg.body['instanceId'] as string;
  console.log(`registered instance ${instanceId}`);

  const ciphertext = Buffer.from('sealed-test-blob').toString('base64');

  // --- APNs ---
  const iosRouting = await enroll(instanceToken, instanceId, 'ios');
  const apns = await call('POST', '/notify', { token: instanceToken, body: { routingToken: iosRouting, ciphertext } });
  const apnsReason = String(apns.body['reason'] ?? apns.body['error'] ?? '');
  const apnsAuthOk = apnsReason === 'BadDeviceToken' || apnsReason === 'DeviceTokenNotForTopic' || apns.status === 410;
  console.log(`\nAPNs  → status ${apns.status}, reason "${apnsReason}"`);
  console.log(apnsAuthOk
    ? '  ✅ APNs .p8 JWT AUTH OK (reached APNs; the fake token was rejected, not our creds)'
    : '  ⚠️  check: reason suggests a credential/topic problem (e.g. InvalidProviderToken/MissingTopic)');

  // --- FCM ---
  const androidRouting = await enroll(instanceToken, instanceId, 'android');
  const fcm = await call('POST', '/notify', { token: instanceToken, body: { routingToken: androidRouting, ciphertext } });
  const fcmReason = String(fcm.body['reason'] ?? fcm.body['error'] ?? '');
  const fcmAuthOk = /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT|invalid/i.test(fcmReason) && !/oauth/i.test(fcmReason);
  console.log(`\nFCM   → status ${fcm.status}, reason "${fcmReason}"`);
  console.log(fcmAuthOk
    ? '  ✅ FCM service-account OAuth OK (reached FCM; the fake token was rejected, not our creds)'
    : '  ⚠️  check: reason suggests OAuth/credential problem');

  console.log('\n' + (apnsAuthOk && fcmAuthOk ? 'BOTH PROVIDERS AUTHENTICATE ✅' : 'review the warnings above'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
