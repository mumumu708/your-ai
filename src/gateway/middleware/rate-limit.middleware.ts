import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { Logger } from '../../shared/logging/logger';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import { RateLimiter } from '../../kernel/security/rate-limiter';
import type { MessageMiddleware, RateLimitMiddlewareConfig } from './middleware.types';

const logger = new Logger('RateLimitMiddleware');

// ── Singleton RateLimiter (with test injection) ───────────────────────────

let rateLimiterInstance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter();
  }
  return rateLimiterInstance;
}

export function setRateLimiter(limiter: RateLimiter): void {
  rateLimiterInstance = limiter;
}

// ── BotMessage pipeline middleware ────────────────────────────────────────

export function createRateLimitMiddleware(config?: RateLimitMiddlewareConfig): MessageMiddleware {
  const disabled = config?.disabled ?? process.env.NODE_ENV === 'development';

  return (next: MessageHandler): MessageHandler => {
    return async (message: BotMessage): Promise<void> => {
      if (disabled) {
        return next(message);
      }

      const limiter = getRateLimiter();
      const result = limiter.consume({ user: message.userId });

      if (!result.allowed) {
        logger.warn('限流拒绝', {
          userId: message.userId,
          channel: message.channel,
          reason: result.reason,
          resetMs: result.resetMs,
        });
        throw new YourBotError(ERROR_CODES.RATE_LIMIT_EXCEEDED, '请求过于频繁，请稍后再试', {
          userId: message.userId,
          remaining: result.remaining,
          resetMs: result.resetMs,
        });
      }

      // Attach rate limit info to metadata for downstream use
      message.metadata.rateLimit = {
        remaining: result.remaining,
        resetMs: result.resetMs,
      };

      return next(message);
    };
  };
}

// ── Hono HTTP middleware for /api/messages ─────────────────────────────────

export function createApiRateLimitMiddleware(config?: RateLimitMiddlewareConfig) {
  const disabled = config?.disabled ?? process.env.NODE_ENV === 'development';

  return async (
    c: {
      req: { header: (name: string) => string | undefined };
      header: (name: string, value: string) => void;
      json: (data: unknown, status?: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    if (disabled) {
      return next();
    }

    // Use X-API-Key or Authorization header as identifier, fallback to 'anonymous'
    const apiKey =
      c.req.header('X-API-Key') ??
      c.req.header('Authorization')?.replace('Bearer ', '') ??
      'anonymous';

    const limiter = getRateLimiter();
    const result = limiter.consume({ api: apiKey });

    // Always set rate limit headers
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.ceil(result.resetMs / 1000);
      c.header('Retry-After', String(retryAfter));
      logger.warn('API 限流拒绝', { apiKey: apiKey.slice(0, 8) + '...', retryAfter });
      return c.json(
        { success: false, error: 'Rate limit exceeded', retryAfter },
        429,
      );
    }

    return next();
  };
}
