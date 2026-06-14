// Per-instance rate limiting — a fixed-window counter, in-memory. Caps cost and
// blast radius (a leaked instance token can't spam without limit, §11/§12).
//
// In-memory is fine for a single-process MVP; a multi-replica deploy would move
// this to Redis. Windows are pruned lazily on access.

interface Window {
  count: number;
  resetAt: number; // epoch ms when the window rolls over
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true if allowed (and counts it); false if the limit is exceeded. */
  take(key: string, now: number = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  /** Drop expired windows — call periodically to bound memory. */
  sweep(now: number = Date.now()): void {
    for (const [key, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(key);
    }
  }
}
