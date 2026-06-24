// Unit tests for the fixed-window rate limiter — the cost/blast-radius cap on a
// leaked instance token. `now` is injected everywhere so the window arithmetic
// is deterministic (no wall clock). Run: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './ratelimit.ts';

// White-box handle on the private window map, for the sweep (memory) tests.
type Internals = { windows: Map<string, { count: number; resetAt: number }> };
const peek = (rl: RateLimiter): Internals => rl as unknown as Internals;

test('take: allows exactly `limit` calls in a window, then blocks', () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.take('k', 0), true);
  assert.equal(rl.take('k', 10), true);
  assert.equal(rl.take('k', 20), true);
  assert.equal(rl.take('k', 30), false, '4th call in-window is blocked');
  assert.equal(rl.take('k', 40), false, 'stays blocked for the rest of the window');
});

test('take: window resets at resetAt (boundary is inclusive: now >= resetAt)', () => {
  const rl = new RateLimiter(2, 60_000);
  assert.equal(rl.take('k', 0), true); // opens window, resetAt = 60_000
  assert.equal(rl.take('k', 1), true); // limit reached
  assert.equal(rl.take('k', 59_999), false, 'still blocked just before reset');
  assert.equal(rl.take('k', 60_000), true, 'reset exactly at resetAt');
  assert.equal(rl.take('k', 60_001), true, 'fresh window allows a second');
  assert.equal(rl.take('k', 60_002), false, 'and re-blocks once refilled');
});

test('take: keys are isolated from one another', () => {
  const rl = new RateLimiter(1, 60_000);
  assert.equal(rl.take('a', 0), true);
  assert.equal(rl.take('a', 1), false, 'a is exhausted');
  assert.equal(rl.take('b', 1), true, 'b is unaffected by a');
});

test('take: respects a custom windowMs', () => {
  const rl = new RateLimiter(1, 1_000);
  assert.equal(rl.take('k', 0), true);
  assert.equal(rl.take('k', 999), false, 'blocked inside the 1s window');
  assert.equal(rl.take('k', 1_000), true, 'allowed once the short window rolls');
});

test('take: a fresh window always grants its first call (seed path), even at limit 0', () => {
  // Documents the boundary precisely: take() seeds a new window with count=1 and
  // returns true before the limit check ever runs. So a limit-0 limiter still
  // lets exactly one call through per window, then blocks. (The relay only ever
  // configures positive limits; this pins the edge so it can't silently change.)
  const zero = new RateLimiter(0, 60_000);
  assert.equal(zero.take('k', 0), true, 'the seeding call is allowed');
  assert.equal(zero.take('k', 1), false, 'every subsequent in-window call blocks');
  assert.equal(zero.take('k', 2), false);
  // Next window: one more leaks, then blocks again.
  assert.equal(zero.take('k', 60_000), true);
  assert.equal(zero.take('k', 60_001), false);
});

test('sweep: drops only windows whose resetAt has passed', () => {
  const rl = new RateLimiter(5, 60_000);
  rl.take('old', 0); // resetAt = 60_000
  rl.take('new', 30_000); // resetAt = 90_000
  assert.equal(peek(rl).windows.size, 2);

  rl.sweep(60_000); // 'old' is now expired (60_000 >= 60_000), 'new' is not
  assert.equal(peek(rl).windows.size, 1);
  assert.ok(peek(rl).windows.has('new'));
  assert.ok(!peek(rl).windows.has('old'));
});

test('sweep: no-op when nothing has expired', () => {
  const rl = new RateLimiter(5, 60_000);
  rl.take('a', 0);
  rl.take('b', 0);
  rl.sweep(59_999);
  assert.equal(peek(rl).windows.size, 2);
});

test('sweep then take re-opens a fresh window for a swept key', () => {
  const rl = new RateLimiter(1, 60_000);
  rl.take('k', 0);
  assert.equal(rl.take('k', 1), false, 'exhausted');
  rl.sweep(60_000); // prune the expired window
  assert.equal(peek(rl).windows.size, 0);
  assert.equal(rl.take('k', 60_000), true, 'fresh window after sweep');
});
