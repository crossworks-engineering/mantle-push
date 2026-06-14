// The shape every push provider implements. The relay forwards an opaque
// ciphertext blob; it never constructs human-readable content.

export type Platform = 'ios' | 'android';

export interface PushTarget {
  platform: Platform;
  osPushToken: string;
}

export interface PushMessage {
  /** base64 of the libsodium sealed box — the only payload that matters. */
  ciphertext: string;
  /** APNs apns-collapse-id / FCM collapse_key — supersede repeated nudges. */
  collapseKey?: string;
  /** "high" → immediate wake (default); "normal" → power-friendly. */
  priority?: 'high' | 'normal';
}

export type DeliveryResult =
  | { ok: true }
  // unregistered = the OS push token is permanently dead (uninstall / token
  // gone). The caller should delete the device row so it isn't retried.
  | { ok: false; status: number; reason: string; unregistered?: boolean };

export interface PushProvider {
  readonly name: string;
  send(target: PushTarget, message: PushMessage): Promise<DeliveryResult>;
  close(): Promise<void>;
}
