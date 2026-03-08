import { describe, expect, test } from 'bun:test';
import { YourBotError } from '../../shared/errors/yourbot-error';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import {
  createApiAuthMiddleware,
  createAuthMiddleware,
  createWebSocketAuthHandler,
  loadAuthConfig,
  verifyJwt,
} from './auth.middleware';
import type { AuthContext, AuthMiddlewareConfig } from './middleware.types';

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

// ── Helper: create a signed JWT HS256 ─────────────────────────────────────

async function createJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };

  const encode = (obj: unknown) => {
    const json = JSON.stringify(obj);
    return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// ── verifyJwt ─────────────────────────────────────────────────────────────

describe('verifyJwt', () => {
  const secret = 'test-secret-key';

  test('verifies a valid JWT', async () => {
    const token = await createJwt({ sub: 'user_1', name: 'Test' }, secret);
    const result = await verifyJwt(token, secret);

    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe('user_1');
  });

  test('rejects invalid signature', async () => {
    const token = await createJwt({ sub: 'user_1' }, secret);
    const result = await verifyJwt(token, 'wrong-secret');

    expect(result.valid).toBe(false);
  });

  test('rejects expired JWT', async () => {
    const token = await createJwt(
      { sub: 'user_1', exp: Math.floor(Date.now() / 1000) - 60 },
      secret,
    );
    const result = await verifyJwt(token, secret);

    expect(result.valid).toBe(false);
  });

  test('rejects malformed token', async () => {
    const result = await verifyJwt('not.a.valid.token.here', secret);
    expect(result.valid).toBe(false);
  });

  test('rejects token with only 2 parts', async () => {
    const result = await verifyJwt('header.payload', secret);
    expect(result.valid).toBe(false);
  });

  test('rejects token with non-JSON payload (triggers catch)', async () => {
    // Build a JWT where the payload is valid base64 but not valid JSON
    // The signature must match so we get past the signature check to JSON.parse
    const header = { alg: 'HS256', typ: 'JWT' };
    const encode = (s: string) =>
      btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const headerB64 = encode(JSON.stringify(header));
    const payloadB64 = encode('not-valid-json'); // valid base64, invalid JSON
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const token = `${headerB64}.${payloadB64}.${sigB64}`;
    const result = await verifyJwt(token, secret);
    expect(result.valid).toBe(false);
  });
});

// ── loadAuthConfig ────────────────────────────────────────────────────────

describe('loadAuthConfig', () => {
  test('应该从环境变量读取配置', () => {
    const config = loadAuthConfig();
    expect(typeof config.devBypass).toBe('boolean');
    // jwtSecret, apiKeys etc. come from env vars — may be undefined in test
    expect(config).toHaveProperty('jwtSecret');
    expect(config).toHaveProperty('feishuVerificationToken');
    expect(config).toHaveProperty('telegramWebhookSecret');
  });
});

// ── createAuthMiddleware (BotMessage pipeline) ────────────────────────────

describe('createAuthMiddleware', () => {
  test('dev bypass sets authContext and calls next', async () => {
    const config: AuthMiddlewareConfig = { devBypass: true };
    const middleware = createAuthMiddleware(config);

    let calledWith: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      calledWith = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage());

    expect(calledWith).not.toBeNull();
    const authCtx = calledWith?.metadata.authContext as AuthContext;
    expect(authCtx.authenticated).toBe(true);
    expect(authCtx.authMethod).toBe('dev_bypass');
  });

  test('feishu channel authenticates by userId presence', async () => {
    const config: AuthMiddlewareConfig = { devBypass: false };
    const middleware = createAuthMiddleware(config);

    let calledWith: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      calledWith = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ channel: 'feishu', userId: 'ou_abc123' }));

    expect(calledWith).not.toBeNull();
    const authCtx = calledWith?.metadata.authContext as AuthContext;
    expect(authCtx.authenticated).toBe(true);
    expect(authCtx.authMethod).toBe('feishu_signature');
  });

  test('feishu channel rejects unknown userId', async () => {
    const config: AuthMiddlewareConfig = { devBypass: false };
    const middleware = createAuthMiddleware(config);
    const next: MessageHandler = async () => {};

    const handler = middleware(next);

    try {
      await handler(createTestMessage({ channel: 'feishu', userId: 'unknown' }));
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).code).toBe('AUTH_FAILED');
    }
  });

  test('telegram channel rejects unknown userId', async () => {
    const config: AuthMiddlewareConfig = { devBypass: false };
    const middleware = createAuthMiddleware(config);
    const next: MessageHandler = async () => {};

    const handler = middleware(next);

    try {
      await handler(createTestMessage({ channel: 'telegram', userId: 'unknown' }));
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).code).toBe('AUTH_FAILED');
    }
  });

  test('telegram channel authenticates by userId presence', async () => {
    const config: AuthMiddlewareConfig = { devBypass: false };
    const middleware = createAuthMiddleware(config);

    let calledWith: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      calledWith = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ channel: 'telegram', userId: '12345' }));

    expect(calledWith).not.toBeNull();
    const authCtx = calledWith?.metadata.authContext as AuthContext;
    expect(authCtx.authMethod).toBe('telegram_bot');
  });

  test('api channel authenticates with valid API key', async () => {
    const config: AuthMiddlewareConfig = {
      devBypass: false,
      apiKeys: ['key-123', 'key-456'],
    };
    const middleware = createAuthMiddleware(config);

    let calledWith: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      calledWith = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ channel: 'api', metadata: { apiKey: 'key-123' } }));

    expect(calledWith).not.toBeNull();
    const authCtx = calledWith?.metadata.authContext as AuthContext;
    expect(authCtx.authMethod).toBe('api_key');
  });

  test('api channel rejects invalid API key', async () => {
    const config: AuthMiddlewareConfig = {
      devBypass: false,
      apiKeys: ['key-123'],
    };
    const middleware = createAuthMiddleware(config);
    const next: MessageHandler = async () => {};

    const handler = middleware(next);

    try {
      await handler(createTestMessage({ channel: 'api', metadata: { apiKey: 'wrong-key' } }));
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).code).toBe('AUTH_FAILED');
    }
  });

  test('web channel rejects invalid JWT token', async () => {
    const config: AuthMiddlewareConfig = {
      devBypass: false,
      jwtSecret: 'web-jwt-secret',
    };
    const middleware = createAuthMiddleware(config);
    const next: MessageHandler = async () => {};
    const handler = middleware(next);

    try {
      await handler(
        createTestMessage({ channel: 'web', metadata: { token: 'invalid.jwt.token' } }),
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(YourBotError);
      expect((error as YourBotError).code).toBe('AUTH_FAILED');
    }
  });

  test('web channel authenticates with JWT in metadata', async () => {
    const secret = 'web-jwt-secret';
    const token = await createJwt({ sub: 'user_web' }, secret);

    const config: AuthMiddlewareConfig = {
      devBypass: false,
      jwtSecret: secret,
    };
    const middleware = createAuthMiddleware(config);

    let calledWith: BotMessage | null = null;
    const next: MessageHandler = async (msg) => {
      calledWith = msg;
    };

    const handler = middleware(next);
    await handler(createTestMessage({ channel: 'web', metadata: { token } }));

    expect(calledWith).not.toBeNull();
    const authCtx = calledWith?.metadata.authContext as AuthContext;
    expect(authCtx.authMethod).toBe('jwt');
    expect(authCtx.userId).toBe('user_web');
  });
});

// ── createApiAuthMiddleware (Hono) ────────────────────────────────────────

describe('createApiAuthMiddleware', () => {
  function createMockHonoContext(headers: Record<string, string> = {}) {
    return {
      req: {
        header: (name: string) => headers[name],
      },
      json: (data: unknown, status?: number) => ({ data, status }) as unknown as Response,
    };
  }

  test('dev bypass calls next', async () => {
    const mw = createApiAuthMiddleware({ devBypass: true });
    let nextCalled = false;

    await mw(createMockHonoContext(), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('valid Bearer token calls next', async () => {
    const mw = createApiAuthMiddleware({ devBypass: false, apiKeys: ['my-key'] });
    let nextCalled = false;

    await mw(createMockHonoContext({ Authorization: 'Bearer my-key' }), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('valid X-API-Key header calls next', async () => {
    const mw = createApiAuthMiddleware({ devBypass: false, apiKeys: ['my-key'] });
    let nextCalled = false;

    await mw(createMockHonoContext({ 'X-API-Key': 'my-key' }), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test('invalid key returns 401', async () => {
    const mw = createApiAuthMiddleware({ devBypass: false, apiKeys: ['my-key'] });
    let nextCalled = false;

    const result = await mw(
      createMockHonoContext({ Authorization: 'Bearer wrong-key' }),
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect((result as { status: number }).status).toBe(401);
  });

  test('missing key returns 401', async () => {
    const mw = createApiAuthMiddleware({ devBypass: false, apiKeys: ['my-key'] });
    let nextCalled = false;

    const result = await mw(createMockHonoContext(), async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect((result as { status: number }).status).toBe(401);
  });
});

// ── createWebSocketAuthHandler ────────────────────────────────────────────

describe('createWebSocketAuthHandler', () => {
  test('dev bypass returns authContext with userId from query', async () => {
    const handler = createWebSocketAuthHandler({ devBypass: true });
    const req = new Request('http://localhost/ws?userId=test_user');

    const result = await handler(req);

    expect(result).not.toBeNull();
    expect(result?.authenticated).toBe(true);
    expect(result?.userId).toBe('test_user');
    expect(result?.authMethod).toBe('dev_bypass');
  });

  test('validates JWT from query param', async () => {
    const secret = 'ws-jwt-secret';
    const token = await createJwt({ sub: 'ws_user' }, secret);
    const handler = createWebSocketAuthHandler({ devBypass: false, jwtSecret: secret });
    const req = new Request(`http://localhost/ws?token=${token}`);

    const result = await handler(req);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('ws_user');
    expect(result?.authMethod).toBe('jwt');
  });

  test('returns null for missing token in production', async () => {
    const handler = createWebSocketAuthHandler({ devBypass: false, jwtSecret: 'secret' });
    const req = new Request('http://localhost/ws');

    const result = await handler(req);
    expect(result).toBeNull();
  });

  test('returns null for invalid JWT', async () => {
    const handler = createWebSocketAuthHandler({ devBypass: false, jwtSecret: 'secret' });
    const req = new Request('http://localhost/ws?token=invalid.jwt.token');

    const result = await handler(req);
    expect(result).toBeNull();
  });
});
