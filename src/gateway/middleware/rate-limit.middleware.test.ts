import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { YourBotError } from '../../shared/errors/yourbot-error';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import { RateLimiter } from '../../kernel/security/rate-limiter';
import {
  createRateLimitMiddleware,
  createApiRateLimitMiddleware,
  getRateLimiter,
  setRateLimiter,
} from './rate-limit.middleware';

function createTestMessage(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    id: 'test_1',
    channel: 'web',
    userId: 'user_1',
    userName: 'Test User',
    conversationId: 'conv_1',
    content: 'hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('createRateLimitMiddleware', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter([
      { level: 'global', maxRequests: 100, windowMs: 60_000 },
      { level: 'user', maxRequests: 3, windowMs: 60_000 },
    ]);
    setRateLimiter(limiter);
  });

  afterEach(() => {
    setRateLimiter(null as unknown as RateLimiter);
  });

  test('disabled mode calls next without consuming', async () => {
    const middleware = createRateLimitMiddleware({ disabled: true });
    let nextCalled = false;
    const next: MessageHandler = async () => {
      nextCalled = true;
    };

    const handler = middleware(next);
    await handler(createTestMessage());

    expect(nextCalled).toBe(true);
  });

  test('allows requests within limit', async () => {
    const middleware = createRateLimitMiddleware({ disabled: false });
    let nextCount = 0;
    const next: MessageHandler = async () => {
      nextCount++;
    };

    const handler = middleware(next);

    await handler(createTestMessage());
    await handler(createTestMessage());
    await handler(createTestMessage());

    expect(nextCount).toBe(3);
  });

  test('rejects requests exceeding limit', async () => {
    const middleware = createRateLimitMiddleware({ disabled: false });
    const next: MessageHandler = async () => {};

    const handler = middleware(next);

    // Consume 3 allowed requests
    await handler(createTestMessage());
    await handler(createTestMessage());
    await handler(createTestMessage());

    // 4th should be rejected
    try {
      await handler(createTestMessage());
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).code).toBe('RATE_LIMIT_EXCEEDED');
    }
  });

  test('attaches rateLimit info to metadata', async () => {
    const middleware = createRateLimitMiddleware({ disabled: false });
    let receivedMsg: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      receivedMsg = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage());

    expect(receivedMsg).not.toBeNull();
    const rl = receivedMsg!.metadata.rateLimit as { remaining: number; resetMs: number };
    expect(typeof rl.remaining).toBe('number');
    expect(rl.remaining).toBeLessThanOrEqual(3);
  });
});

describe('createApiRateLimitMiddleware', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter([
      { level: 'global', maxRequests: 100, windowMs: 60_000 },
      { level: 'api', maxRequests: 2, windowMs: 60_000 },
    ]);
    setRateLimiter(limiter);
  });

  afterEach(() => {
    setRateLimiter(null as unknown as RateLimiter);
  });

  function createMockHonoContext(headers: Record<string, string> = {}) {
    const responseHeaders: Record<string, string> = {};
    return {
      req: { header: (name: string) => headers[name] },
      header: (name: string, value: string) => {
        responseHeaders[name] = value;
      },
      json: (data: unknown, status?: number) => ({ data, status } as unknown as Response),
      responseHeaders,
    };
  }

  test('disabled mode calls next', async () => {
    const mw = createApiRateLimitMiddleware({ disabled: true });
    let nextCalled = false;

    await mw(createMockHonoContext(), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('sets rate limit headers', async () => {
    const mw = createApiRateLimitMiddleware({ disabled: false });
    const ctx = createMockHonoContext({ 'X-API-Key': 'test-key' });

    await mw(ctx, async () => {});

    expect(ctx.responseHeaders['X-RateLimit-Remaining']).toBeDefined();
    expect(ctx.responseHeaders['X-RateLimit-Reset']).toBeDefined();
  });

  test('returns 429 when limit exceeded', async () => {
    const mw = createApiRateLimitMiddleware({ disabled: false });

    // Consume 2 allowed requests
    await mw(createMockHonoContext({ 'X-API-Key': 'test-key' }), async () => {});
    await mw(createMockHonoContext({ 'X-API-Key': 'test-key' }), async () => {});

    // 3rd should be rejected
    const ctx = createMockHonoContext({ 'X-API-Key': 'test-key' });
    let nextCalled = false;
    const result = await mw(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect((result as { status: number }).status).toBe(429);
    expect(ctx.responseHeaders['Retry-After']).toBeDefined();
  });
});

describe('getRateLimiter / setRateLimiter', () => {
  afterEach(() => {
    setRateLimiter(null as unknown as RateLimiter);
  });

  test('getRateLimiter creates default instance if none set', () => {
    setRateLimiter(null as unknown as RateLimiter);
    // Reset the internal reference
    // @ts-expect-error - accessing internal for test reset
    const _rl = getRateLimiter();
    expect(_rl).toBeInstanceOf(RateLimiter);
  });

  test('setRateLimiter injects custom instance', () => {
    const custom = new RateLimiter([{ level: 'user', maxRequests: 1, windowMs: 1000 }]);
    setRateLimiter(custom);
    expect(getRateLimiter()).toBe(custom);
  });
});
