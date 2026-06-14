// End-to-end smoke test for the relay spine (push-notifications.md §14, M1:
// "verifiable with a CLI before any app work"). Plays all three roles —
// Mantle (mints tokens/tickets), the app (enrolls), and the sender (notifies) —
// against a running mantle-push with PUSH_PROVIDER=mock.
//
//   node src/migrate.ts && node src/index.ts &   # in one shell
//   node scripts/smoke.ts                          # in another
//
// Exits non-zero on the first failed assertion.

import { generateToken } from '../src/lib/tokens.ts';
import { mintTicket } from '../src/lib/ticket.ts';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${msg}`);
}

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> {
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

async function main(): Promise<void> {
  const health = await call('GET', '/healthz');
  ok(health.status === 200 && health.body['ok'] === true, `healthz ok (provider=${health.body['provider']})`);
  ok(health.body['provider'] === 'mock', 'running with the mock provider');

  // 1) Mantle generates its instance token and registers (TOFU).
  const instanceToken = generateToken();
  const reg = await call('POST', '/instances', { body: { instanceToken } });
  const instanceId = reg.body['instanceId'] as string;
  ok(reg.status === 200 && typeof instanceId === 'string', `register instance → ${instanceId}`);

  // Idempotent claim.
  const reg2 = await call('POST', '/instances', { body: { instanceToken } });
  ok(reg2.status === 200 && reg2.body['instanceId'] === instanceId, 're-register is idempotent (same id)');

  // 2) App enrolls a device using a Mantle-minted ticket.
  const osPushToken = 'apns-token-' + generateToken().slice(0, 24);
  const ticket = mintTicket({ iid: instanceId, osPushToken, instanceToken });
  const enroll = await call('POST', '/enroll', { body: { ticket, platform: 'ios', osPushToken } });
  const routingToken = enroll.body['routingToken'] as string;
  ok(enroll.status === 200 && typeof routingToken === 'string', `enroll device → routingToken ${routingToken.slice(0, 8)}…`);

  // 3) Notify (instance-token auth) → mock "delivers".
  const ciphertext = Buffer.from('sealed-box-bytes-would-be-here').toString('base64');
  const notify = await call('POST', '/notify', {
    token: instanceToken,
    body: { routingToken, ciphertext, collapseKey: 'assistant' },
  });
  ok(notify.status === 200 && notify.body['ok'] === true, 'notify delivered (mock)');

  // 4) Instance device list shows the one device.
  const list = await call('GET', '/instance', { token: instanceToken });
  const devices = (list.body['devices'] as unknown[]) ?? [];
  ok(list.status === 200 && devices.length === 1, `GET /instance lists ${devices.length} device`);

  // --- Negative paths: the security boundaries must hold ---

  ok((await call('POST', '/notify', { token: generateToken(), body: { routingToken, ciphertext } })).status === 401,
    'notify with a bogus instance token → 401');

  const tampered = ticket.slice(0, -2) + (ticket.endsWith('AA') ? 'BB' : 'AA');
  ok((await call('POST', '/enroll', { body: { ticket: tampered, platform: 'ios', osPushToken } })).status === 401,
    'enroll with a tampered ticket → 401');

  ok((await call('POST', '/enroll', { body: { ticket, platform: 'ios', osPushToken: 'different-token' } })).status === 401,
    'enroll where osPushToken ≠ ticket binding → 401');

  // A second instance cannot push to the first instance's device.
  const otherToken = generateToken();
  await call('POST', '/instances', { body: { instanceToken: otherToken } });
  ok((await call('POST', '/notify', { token: otherToken, body: { routingToken, ciphertext } })).status === 403,
    "another instance can't push to this device → 403");

  // 5) Rotate + unpair.
  ok((await call('POST', '/refresh', { token: routingToken, body: { osPushToken: 'rotated-token' } })).status === 200,
    'refresh OS token (routing-token auth) → 200');
  ok((await call('DELETE', '/device', { token: instanceToken, body: { routingToken } })).status === 200,
    'unpair device (instance-token auth) → 200');
  ok((await call('POST', '/notify', { token: instanceToken, body: { routingToken, ciphertext } })).status === 404,
    'notify to the unpaired device → 404');

  console.log(`\nall ${passed} checks passed ✅`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
