import type { ChannelType, MessageHandler } from '../../shared/messaging';

// ── Middleware pipeline ───────────────────────────────────────────────────

export type MessageMiddleware = (next: MessageHandler) => MessageHandler;

// ── Auth context ──────────────────────────────────────────────────────────

export type AuthMethod = 'feishu_signature' | 'telegram_bot' | 'jwt' | 'api_key' | 'dev_bypass';

export interface AuthContext {
  authenticated: boolean;
  userId: string;
  channel: ChannelType;
  authMethod: AuthMethod;
  authenticatedAt: number;
}

// ── Middleware configs ─────────────────────────────────────────────────────

export interface AuthMiddlewareConfig {
  devBypass: boolean;
  jwtSecret?: string;
  apiKeys?: string[];
  feishuVerificationToken?: string;
  telegramWebhookSecret?: string;
}

export interface RateLimitMiddlewareConfig {
  disabled: boolean;
}
