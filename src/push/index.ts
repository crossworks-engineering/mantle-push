// Provider selection + per-platform dispatch. One process holds one provider of
// each kind it needs; `dispatch` routes a target to APNs or FCM by platform.

import { config } from '../config.ts';
import { createApnsProvider } from './apns.ts';
import { createFcmProvider } from './fcm.ts';
import { createMockProvider } from './mock.ts';
import type { DeliveryResult, PushMessage, PushProvider, PushTarget } from './types.ts';

export type { DeliveryResult, PushMessage, PushTarget } from './types.ts';

export interface PushDispatcher {
  send(target: PushTarget, message: PushMessage): Promise<DeliveryResult>;
  close(): Promise<void>;
  describe(): string;
}

export function createDispatcher(): PushDispatcher {
  if (config.provider === 'mock') {
    const mock = createMockProvider();
    return {
      send: (t, m) => mock.send(t, m),
      close: () => mock.close(),
      describe: () => 'mock (logs deliveries; no real APNs/FCM)',
    };
  }

  const apns: PushProvider = createApnsProvider({
    topic: config.apns.topic,
    keyId: config.apns.keyId,
    teamId: config.apns.teamId,
    keyP8: config.apns.key ?? '',
    production: config.apns.production,
  });
  const fcm: PushProvider = createFcmProvider({
    projectId: config.fcm.projectId,
    serviceAccountJson: config.fcm.serviceAccount ?? '',
  });

  return {
    send(target, message) {
      return target.platform === 'ios' ? apns.send(target, message) : fcm.send(target, message);
    },
    async close() {
      await Promise.all([apns.close(), fcm.close()]);
    },
    describe: () => `live (apns ${config.apns.production ? 'prod' : 'sandbox'} + fcm)`,
  };
}
