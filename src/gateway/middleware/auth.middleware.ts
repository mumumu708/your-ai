import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { Logger } from '../../shared/logging/logger';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import type { AuthContext, AuthMiddlewareConfig, MessageMiddleware } from './middleware.types';

const logger = new Logger('AuthMiddleware');

// ── Config loader ─────────────────────────────────────────────────────────

export function loadAuthConfig(): AuthMiddlewareConfig {
  return {
    devBypass: process.env.NODE_ENV === 'development',
    jwtSecret: process.env.JWT_SECRET,
    apiKeys: process.env.API_KEYS?.split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  };
}

// ── JWT verification (Bun crypto.subtle, HS256) ───────────────────────────

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
    const expectedSig = base64UrlEncode(new Uint8Array(signature));

    if (expectedSig !== signatureB64) return { valid: false };

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64!)));

    // Check expiration
    if (payload.exp && typeof payload.exp === 'number') {
      if (Date.now() / 1000 > payload.exp) return { valid: false };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

// ── Channel-specific authentication ───────────────────────────────────────

function authenticateFeishu(message: BotMessage): AuthContext | null {
  // Feishu WSClient authenticates via appId/appSecret at connection level.
  // At message level, we verify the sender identity exists.
  if (message.userId && message.userId !== 'unknown') {
    return {
      authenticated: true,
      userId: message.userId,
      channel: 'feishu',
      authMethod: 'feishu_signature',
      authenticatedAt: Date.now(),
    };
  }
  return null;
}

function authenticateTelegram(message: BotMessage): AuthContext | null {
  // Telegraf authenticates via botToken at connection level.
  // At message level, we verify from.id exists.
  if (message.userId && message.userId !== 'unknown') {
    return {
      authenticated: true,
      userId: message.userId,
      channel: 'telegram',
      authMethod: 'telegram_bot',
      authenticatedAt: Date.now(),
    };
  }
  return null;
}

async function authenticateWeb(
  message: BotMessage,
  config: AuthMiddlewareConfig,
): Promise<AuthContext | null> {
  // Web channel: check for JWT in metadata (injected by WebSocket auth handler)
  const authContext = message.metadata.authContext as AuthContext | undefined;
  if (authContext?.authenticated) return authContext;

  // Fallback: check for token in metadata
  const token = message.metadata.token as string | undefined;
  if (token && config.jwtSecret) {
    const result = await verifyJwt(token, config.jwtSecret);
    if (result.valid) {
      return {
        authenticated: true,
        userId: (result.payload?.sub as string) ?? message.userId,
        channel: 'web',
        authMethod: 'jwt',
        authenticatedAt: Date.now(),
      };
    }
  }

  return null;
}

function authenticateApi(message: BotMessage, config: AuthMiddlewareConfig): AuthContext | null {
  const apiKey = message.metadata.apiKey as string | undefined;
  if (apiKey && config.apiKeys?.includes(apiKey)) {
    return {
      authenticated: true,
      userId: message.userId,
      channel: 'api',
      authMethod: 'api_key',
      authenticatedAt: Date.now(),
    };
  }
  return null;
}

// ── BotMessage pipeline middleware ────────────────────────────────────────

export function createAuthMiddleware(config?: AuthMiddlewareConfig): MessageMiddleware {
  const cfg = config ?? loadAuthConfig();

  return (next: MessageHandler): MessageHandler => {
    return async (message: BotMessage): Promise<void> => {
      // Dev bypass
      if (cfg.devBypass) {
        message.metadata.authContext = {
          authenticated: true,
          userId: message.userId,
          channel: message.channel,
          authMethod: 'dev_bypass',
          authenticatedAt: Date.now(),
        } satisfies AuthContext;
        return next(message);
      }

      let authContext: AuthContext | null = null;

      switch (message.channel) {
        case 'feishu':
          authContext = authenticateFeishu(message);
          break;
        case 'telegram':
          authContext = authenticateTelegram(message);
          break;
        case 'web':
          authContext = await authenticateWeb(message, cfg);
          break;
        case 'api':
          authContext = authenticateApi(message, cfg);
          break;
      }

      if (!authContext) {
        logger.warn('认证失败', { channel: message.channel, userId: message.userId });
        throw new YourBotError(ERROR_CODES.AUTH_FAILED, '认证失败', {
          channel: message.channel,
          userId: message.userId,
        });
      }

      message.metadata.authContext = authContext;
      return next(message);
    };
  };
}

// ── Hono HTTP middleware for /api/messages ─────────────────────────────────

export function createApiAuthMiddleware(config?: AuthMiddlewareConfig) {
  const cfg = config ?? loadAuthConfig();

  return async (
    c: {
      req: { header: (name: string) => string | undefined };
      json: (data: unknown, status?: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    // Dev bypass
    if (cfg.devBypass) {
      return next();
    }

    // Check Authorization: Bearer <key> or X-API-Key header
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');

    let apiKey: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      apiKey = authHeader.slice(7);
    } else if (xApiKey) {
      apiKey = xApiKey;
    }

    if (!apiKey || !cfg.apiKeys?.includes(apiKey)) {
      logger.warn('API 认证失败', { hasKey: !!apiKey });
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    return next();
  };
}

// ── WebSocket upgrade auth handler ────────────────────────────────────────

export function createWebSocketAuthHandler(config?: AuthMiddlewareConfig) {
  const cfg = config ?? loadAuthConfig();

  return async (req: Request): Promise<AuthContext | null> => {
    // Dev bypass
    if (cfg.devBypass) {
      const url = new URL(req.url);
      const userId = url.searchParams.get('userId') ?? 'anon';
      return {
        authenticated: true,
        userId,
        channel: 'web',
        authMethod: 'dev_bypass',
        authenticatedAt: Date.now(),
      };
    }

    // Check for JWT token in query param or header
    const url = new URL(req.url);
    const token =
      url.searchParams.get('token') ?? req.headers.get('Authorization')?.replace('Bearer ', '');

    if (!token || !cfg.jwtSecret) return null;

    const result = await verifyJwt(token, cfg.jwtSecret);
    if (!result.valid) return null;

    return {
      authenticated: true,
      userId: (result.payload?.sub as string) ?? 'unknown',
      channel: 'web',
      authMethod: 'jwt',
      authenticatedAt: Date.now(),
    };
  };
}
