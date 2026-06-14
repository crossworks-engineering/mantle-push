// The relay HTTP surface (push-notifications.md §7.1). Hono app + handlers.
//
//   POST   /instances   TOFU register/claim an install            (instance token in body)
//   POST   /enroll       create a device, return a routing token   (enrollment ticket)
//   POST   /notify       seal-blind forward to APNs/FCM            (instance token, Bearer)
//   POST   /refresh      OS push token rotated                     (routing token, Bearer)
//   DELETE /device       unpair a device                          (routing OR instance token)
//   GET    /instance     device list (metadata only)              (instance token, Bearer)
//   GET    /healthz      liveness

import { Hono } from 'hono';
import { config } from './config.ts';
import { RateLimiter } from './lib/ratelimit.ts';
import { decodeTicketPayload, verifyTicket } from './lib/ticket.ts';
import {
  claimInstance,
  createDevice,
  deleteDeviceById,
  deleteDeviceByRoutingToken,
  deleteDeviceForInstance,
  findDeviceByRoutingToken,
  findInstanceById,
  findInstanceByToken,
  listDevices,
  markDevicePushed,
  refreshDeviceToken,
} from './lib/store.ts';
import { createDispatcher, type PushDispatcher } from './push/index.ts';
import type { Platform } from './push/types.ts';

function bearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1]!.trim() : null;
}

function isPlatform(v: unknown): v is Platform {
  return v === 'ios' || v === 'android';
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AppDeps {
  dispatcher: PushDispatcher;
  notifyLimiter: RateLimiter;
  enrollLimiter: RateLimiter;
}

export function buildApp(deps: AppDeps): Hono {
  const { dispatcher, notifyLimiter, enrollLimiter } = deps;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true, provider: config.provider }));

  // --- POST /instances — TOFU register/claim ---
  app.post('/instances', async (c) => {
    const body = await jsonBody(c);
    const instanceToken = body?.['instanceToken'];
    if (typeof instanceToken !== 'string' || instanceToken.length < 32) {
      return c.json({ error: 'invalid_instance_token' }, 400);
    }
    const instanceId = await claimInstance(instanceToken);
    return c.json({ instanceId });
  });

  // --- POST /enroll — verify ticket, create device, return routing token ---
  app.post('/enroll', async (c) => {
    const body = await jsonBody(c);
    const ticket = body?.['ticket'];
    const osPushToken = body?.['osPushToken'];
    const platform = body?.['platform'];
    if (typeof ticket !== 'string' || typeof osPushToken !== 'string' || !isPlatform(platform)) {
      return c.json({ error: 'invalid_body' }, 400);
    }

    // Decode → find instance → verify signature against its stored hash.
    const peek = decodeTicketPayload(ticket);
    if (!peek) return c.json({ error: 'invalid_ticket' }, 401);

    if (!enrollLimiter.take(peek.iid)) return c.json({ error: 'rate_limited' }, 429);

    const instance = await findInstanceById(peek.iid);
    if (!instance) return c.json({ error: 'unknown_instance' }, 401);

    const verdict = verifyTicket(ticket, instance.instance_token_hash);
    if (!verdict.ok) return c.json({ error: 'invalid_ticket', reason: verdict.reason }, 401);
    // The ticket is bound to one device's push token.
    if (verdict.payload.osPushToken !== osPushToken) {
      return c.json({ error: 'ticket_token_mismatch' }, 401);
    }

    const pubkeyFingerprint = typeof body?.['publicKeyFingerprint'] === 'string'
      ? (body['publicKeyFingerprint'] as string)
      : null;
    const label = typeof body?.['label'] === 'string' ? (body['label'] as string) : null;

    const device = await createDevice({
      instanceId: instance.id,
      platform,
      osPushToken,
      pubkeyFingerprint,
      label,
    });
    return c.json({ routingToken: device.routingToken, deviceId: device.id });
  });

  // --- POST /notify — instance-token auth; forward ciphertext to APNs/FCM ---
  app.post('/notify', async (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const instance = await findInstanceByToken(token);
    if (!instance) return c.json({ error: 'unauthorized' }, 401);

    if (!notifyLimiter.take(instance.id)) return c.json({ error: 'rate_limited' }, 429);

    const body = await jsonBody(c);
    const routingToken = body?.['routingToken'];
    const ciphertext = body?.['ciphertext'];
    if (typeof routingToken !== 'string' || typeof ciphertext !== 'string') {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const priority = body?.['priority'] === 'normal' ? 'normal' : 'high';
    const collapseKey = typeof body?.['collapseKey'] === 'string' ? (body['collapseKey'] as string) : undefined;

    const device = await findDeviceByRoutingToken(routingToken);
    if (!device) return c.json({ error: 'unknown_device' }, 404);
    // An instance may only push to devices enrolled under itself.
    if (device.instance_id !== instance.id) return c.json({ error: 'forbidden' }, 403);

    const result = await dispatcher.send(
      { platform: device.platform, osPushToken: device.os_push_token },
      { ciphertext, collapseKey, priority },
    );

    if (result.ok) {
      await markDevicePushed(device.id);
      return c.json({ ok: true });
    }
    if (result.unregistered) {
      // The OS token is dead — drop the device so it isn't retried.
      await deleteDeviceById(device.id);
      return c.json({ error: 'device_unregistered', reason: result.reason }, 410);
    }
    return c.json({ error: 'delivery_failed', reason: result.reason }, 502);
  });

  // --- POST /refresh — routing-token auth; update the OS push token ---
  app.post('/refresh', async (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const body = await jsonBody(c);
    const osPushToken = body?.['osPushToken'];
    if (typeof osPushToken !== 'string') return c.json({ error: 'invalid_body' }, 400);
    const ok = await refreshDeviceToken(token, osPushToken);
    if (!ok) return c.json({ error: 'unknown_device' }, 404);
    return c.json({ ok: true });
  });

  // --- DELETE /device — routing-token OR instance-token auth ---
  app.delete('/device', async (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const body = await jsonBody(c);
    const routingToken = body?.['routingToken'];

    // Instance-token path: delete a named device under this instance.
    const instance = await findInstanceByToken(token);
    if (instance) {
      if (typeof routingToken !== 'string') return c.json({ error: 'invalid_body' }, 400);
      const ok = await deleteDeviceForInstance(instance.id, routingToken);
      return ok ? c.json({ ok: true }) : c.json({ error: 'unknown_device' }, 404);
    }
    // Routing-token path: the bearer IS the device.
    const ok = await deleteDeviceByRoutingToken(token);
    return ok ? c.json({ ok: true }) : c.json({ error: 'unauthorized' }, 401);
  });

  // --- GET /instance — device list (metadata only) ---
  app.get('/instance', async (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const instance = await findInstanceByToken(token);
    if (!instance) return c.json({ error: 'unauthorized' }, 401);
    const devices = await listDevices(instance.id);
    return c.json({ instanceId: instance.id, devices });
  });

  return app;
}

/** Build the app with production dependencies (real config-driven dispatcher). */
export function buildDefaultApp(): { app: Hono; deps: AppDeps } {
  const deps: AppDeps = {
    dispatcher: createDispatcher(),
    notifyLimiter: new RateLimiter(config.rate.notifyPerMin),
    enrollLimiter: new RateLimiter(config.rate.enrollPerMin),
  };
  return { app: buildApp(deps), deps };
}
