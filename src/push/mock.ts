// Mock provider — the default. Logs each "delivery" and succeeds, so the whole
// instances→enroll→notify spine is verifiable from a CLI with no Apple/Google
// credentials (push-notifications.md §14, M1: "verifiable with a CLI before any
// app work"). Records sends in memory for assertions in tests/smoke.

import type { DeliveryResult, PushMessage, PushProvider, PushTarget } from './types.ts';

export interface MockRecord {
  platform: string;
  osPushToken: string;
  ciphertextLen: number;
  collapseKey?: string;
}

export function createMockProvider(): PushProvider & { readonly sent: ReadonlyArray<MockRecord> } {
  const sent: MockRecord[] = [];
  return {
    name: 'mock',
    get sent() {
      return sent;
    },
    async send(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
      const rec: MockRecord = {
        platform: target.platform,
        osPushToken: target.osPushToken,
        ciphertextLen: message.ciphertext.length,
        ...(message.collapseKey ? { collapseKey: message.collapseKey } : {}),
      };
      sent.push(rec);
      console.log(
        `[mock-push] → ${rec.platform} ${rec.osPushToken.slice(0, 12)}… ` +
          `ct=${rec.ciphertextLen}B${rec.collapseKey ? ` collapse=${rec.collapseKey}` : ''}`,
      );
      return { ok: true };
    },
    async close() {},
  };
}
