import { describe, expect, test } from 'bun:test';
import { RateLimiter } from './rate-limiter';
import type { RateLimitRule } from './rate-limiter';

const rules: RateLimitRule[] = [
  { level: 'global', maxRequests: 5, windowMs: 1000 },
  { level: 'user', maxRequests: 3, windowMs: 1000 },
  { level: 'agent', maxRequests: 2, windowMs: 1000 },
];

describe('RateLimiter', () => {
  test('should allow requests within limit', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    const result = limiter.consume({ user: 'u1' });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test('should block user when limit exceeded', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    // User limit is 3
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });

    const result = limiter.consume({ user: 'u1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('user');
    expect(result.remaining).toBe(0);
  });

  test('should block global when limit exceeded', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    // Global limit is 5 — use different users to avoid user limit
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u2' });
    limiter.consume({ user: 'u2' });

    const result = limiter.consume({ user: 'u3' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('global');
  });

  test('should enforce agent-level limits', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    // Agent limit is 2
    limiter.consume({ user: 'u1', agent: 'a1' });
    limiter.consume({ user: 'u1', agent: 'a1' });

    const result = limiter.consume({ user: 'u1', agent: 'a1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('agent');
  });

  test('should expire old requests after window', () => {
    let now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    // Fill up user limit
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });

    // Blocked
    expect(limiter.consume({ user: 'u1' }).allowed).toBe(false);

    // Advance past the window (1000ms)
    now = 2001;

    // Should be allowed again
    const result = limiter.consume({ user: 'u1' });
    expect(result.allowed).toBe(true);
  });

  test('should track different users independently', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    // Fill u1 to limit
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    expect(limiter.consume({ user: 'u1' }).allowed).toBe(false);

    // u2 should still be allowed
    expect(limiter.consume({ user: 'u2' }).allowed).toBe(true);
  });

  test('should report correct remaining count', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    limiter.consume({ user: 'u1' });
    const result = limiter.check({ user: 'u1' });
    expect(result.allowed).toBe(true);
    // user limit 3, consumed 1 → remaining 2
    // But min of global remaining (4) and user remaining (2) → 2
    expect(result.remaining).toBe(2);
  });

  test('should calculate resetMs correctly', () => {
    let now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });

    // Blocked, resetMs should be window duration from oldest request
    now = 1500;
    const result = limiter.check({ user: 'u1' });
    expect(result.allowed).toBe(false);
    expect(result.resetMs).toBe(500); // 1000 + 1000 - 1500 = 500
  });

  test('should get usage stats', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });

    const usage = limiter.getUsage('user', 'u1');
    expect(usage.count).toBe(2);
    expect(usage.maxRequests).toBe(3);
    expect(usage.windowMs).toBe(1000);
  });

  test('should reset all windows', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    expect(limiter.consume({ user: 'u1' }).allowed).toBe(false);

    limiter.reset();
    expect(limiter.consume({ user: 'u1' }).allowed).toBe(true);
  });

  test('should reset specific key', () => {
    const now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });
    limiter.consume({ user: 'u1' });

    limiter.resetKey('user', 'u1');
    const usage = limiter.getUsage('user', 'u1');
    expect(usage.count).toBe(0);
  });

  test('should allow unknown levels gracefully', () => {
    const now = 1000;
    const noAgentRules: RateLimitRule[] = [{ level: 'global', maxRequests: 10, windowMs: 1000 }];
    const limiter = new RateLimiter(noAgentRules, () => now);

    // Agent level has no rule, should just pass
    const result = limiter.consume({ user: 'u1', agent: 'a1' });
    expect(result.allowed).toBe(true);
  });

  test('should handle sliding window correctly with partial expiry', () => {
    let now = 1000;
    const limiter = new RateLimiter(rules, () => now);

    // Fill user limit at t=1000
    limiter.consume({ user: 'u1' });
    now = 1200;
    limiter.consume({ user: 'u1' });
    now = 1400;
    limiter.consume({ user: 'u1' });

    // At t=1400, all 3 in window → blocked
    expect(limiter.consume({ user: 'u1' }).allowed).toBe(false);

    // At t=2001, the first request (t=1000) expired but t=1200 and t=1400 still in window
    now = 2001;
    const result = limiter.consume({ user: 'u1' });
    expect(result.allowed).toBe(true);

    // Now 3 again (t=1200, t=1400, t=2001) → blocked
    expect(limiter.consume({ user: 'u1' }).allowed).toBe(false);
  });
});
