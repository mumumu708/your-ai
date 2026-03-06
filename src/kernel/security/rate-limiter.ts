import { Logger } from '../../shared/logging/logger';

// ── Types ──────────────────────────────────────────────────────────────────

export type RateLimitLevel = 'global' | 'user' | 'api' | 'agent';

export interface RateLimitRule {
  level: RateLimitLevel;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  reason?: string;
}

interface SlidingWindow {
  timestamps: number[];
}

// ── Default rules from docs ────────────────────────────────────────────────

export const DEFAULT_RATE_LIMITS: RateLimitRule[] = [
  { level: 'global', maxRequests: 1000, windowMs: 60_000 },
  { level: 'user', maxRequests: 60, windowMs: 60_000 },
  { level: 'api', maxRequests: 100, windowMs: 60_000 },
  { level: 'agent', maxRequests: 10, windowMs: 60_000 },
];

// ── RateLimiter ────────────────────────────────────────────────────────────

/**
 * Sliding window rate limiter with multi-level support.
 * Each level (global, user, api, agent) is independently tracked.
 */
export class RateLimiter {
  private readonly logger = new Logger('RateLimiter');
  private readonly rules: Map<RateLimitLevel, RateLimitRule>;
  private readonly windows = new Map<string, SlidingWindow>();
  private readonly nowFn: () => number;

  constructor(rules?: RateLimitRule[], nowFn?: () => number) {
    this.rules = new Map();
    for (const rule of rules ?? DEFAULT_RATE_LIMITS) {
      this.rules.set(rule.level, rule);
    }
    this.nowFn = nowFn ?? (() => Date.now());
  }

  /**
   * Check if a request is allowed, considering all applicable levels.
   * keys: map of level → identifier (e.g. { user: 'user_001', api: 'key_abc' })
   */
  check(keys: Partial<Record<RateLimitLevel, string>>): RateLimitCheckResult {
    const now = this.nowFn();

    // Always check global
    const globalResult = this.checkLevel('global', '__global__', now);
    if (!globalResult.allowed) return globalResult;

    // Check each specified level
    for (const [level, identifier] of Object.entries(keys) as [RateLimitLevel, string][]) {
      const result = this.checkLevel(level, identifier, now);
      if (!result.allowed) return result;
    }

    // Return the most restrictive remaining count
    let minRemaining = globalResult.remaining;
    let minResetMs = globalResult.resetMs;

    for (const [level, identifier] of Object.entries(keys) as [RateLimitLevel, string][]) {
      const rule = this.rules.get(level);
      if (!rule) continue;
      const key = `${level}:${identifier}`;
      const window = this.windows.get(key);
      const count = window ? window.timestamps.length : 0;
      const remaining = rule.maxRequests - count;
      if (remaining < minRemaining) {
        minRemaining = remaining;
        minResetMs = this.calculateResetMs(window, rule, now);
      }
    }

    return { allowed: true, remaining: minRemaining, resetMs: minResetMs };
  }

  /**
   * Record a request (consume a slot).
   */
  consume(keys: Partial<Record<RateLimitLevel, string>>): RateLimitCheckResult {
    const result = this.check(keys);
    if (!result.allowed) return result;

    const now = this.nowFn();

    // Record in global window
    this.record('global', '__global__', now);

    // Record in each specified level
    for (const [level, identifier] of Object.entries(keys) as [RateLimitLevel, string][]) {
      this.record(level, identifier, now);
    }

    // Calculate remaining after recording (without re-checking allowed)
    let minRemaining = Number.POSITIVE_INFINITY;
    let minResetMs = 0;

    // Check global remaining
    const globalRule = this.rules.get('global');
    if (globalRule) {
      const gWindow = this.windows.get('global:__global__');
      const gCount = gWindow ? gWindow.timestamps.length : 0;
      const gRemaining = globalRule.maxRequests - gCount;
      if (gRemaining < minRemaining) {
        minRemaining = gRemaining;
        minResetMs = this.calculateResetMs(gWindow, globalRule, now);
      }
    }

    for (const [level, identifier] of Object.entries(keys) as [RateLimitLevel, string][]) {
      const rule = this.rules.get(level);
      if (!rule) continue;
      const key = `${level}:${identifier}`;
      const window = this.windows.get(key);
      const count = window ? window.timestamps.length : 0;
      const remaining = rule.maxRequests - count;
      if (remaining < minRemaining) {
        minRemaining = remaining;
        minResetMs = this.calculateResetMs(window, rule, now);
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, minRemaining),
      resetMs: minResetMs,
    };
  }

  /**
   * Get current usage stats for a specific level+identifier.
   */
  getUsage(
    level: RateLimitLevel,
    identifier: string,
  ): { count: number; maxRequests: number; windowMs: number } {
    const rule = this.rules.get(level);
    if (!rule) return { count: 0, maxRequests: 0, windowMs: 0 };

    const now = this.nowFn();
    const key = `${level}:${identifier}`;
    this.pruneWindow(key, now, rule.windowMs);
    const window = this.windows.get(key);

    return {
      count: window ? window.timestamps.length : 0,
      maxRequests: rule.maxRequests,
      windowMs: rule.windowMs,
    };
  }

  /**
   * Reset all windows (useful for testing).
   */
  reset(): void {
    this.windows.clear();
  }

  /**
   * Reset a specific level+identifier window.
   */
  resetKey(level: RateLimitLevel, identifier: string): void {
    this.windows.delete(`${level}:${identifier}`);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private checkLevel(level: RateLimitLevel, identifier: string, now: number): RateLimitCheckResult {
    const rule = this.rules.get(level);
    if (!rule) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetMs: 0 };
    }

    const key = `${level}:${identifier}`;
    this.pruneWindow(key, now, rule.windowMs);

    const window = this.windows.get(key);
    const count = window ? window.timestamps.length : 0;
    const remaining = rule.maxRequests - count;
    const resetMs = this.calculateResetMs(window, rule, now);

    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        resetMs,
        reason: `${level} 级别限流：${rule.maxRequests} 次/${rule.windowMs / 1000}秒`,
      };
    }

    return { allowed: true, remaining, resetMs };
  }

  private record(level: RateLimitLevel, identifier: string, now: number): void {
    const key = `${level}:${identifier}`;
    const window = this.windows.get(key);
    if (window) {
      window.timestamps.push(now);
    } else {
      this.windows.set(key, { timestamps: [now] });
    }
  }

  private pruneWindow(key: string, now: number, windowMs: number): void {
    const window = this.windows.get(key);
    if (!window) return;

    const cutoff = now - windowMs;
    // Remove timestamps older than the window
    while (
      window.timestamps.length > 0 &&
      window.timestamps[0] !== undefined &&
      window.timestamps[0] <= cutoff
    ) {
      window.timestamps.shift();
    }

    if (window.timestamps.length === 0) {
      this.windows.delete(key);
    }
  }

  private calculateResetMs(
    window: SlidingWindow | undefined,
    rule: RateLimitRule,
    now: number,
  ): number {
    if (!window || window.timestamps.length === 0) return 0;
    const oldest = window.timestamps[0] ?? 0;
    return Math.max(0, oldest + rule.windowMs - now);
  }
}
