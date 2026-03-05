import { Logger } from '../../shared/logging/logger';
import type { BotMessage, MessageHandler } from '../../shared/messaging';
import { generateId, generateTraceId } from '../../shared/utils/crypto';
import type { MessageMiddleware } from './middleware.types';

const logger = new Logger('TransformMiddleware');

/**
 * Sanitize userId to prevent injection attacks.
 * Allows alphanumeric, underscores, hyphens, and dots only.
 */
function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_\-.:]/g, '');
}

/**
 * Message normalization middleware.
 * - Ensures message.id exists
 * - Trims content whitespace
 * - Ensures timestamp
 * - Adds traceId to metadata
 * - Sanitizes userId
 */
export function createTransformMiddleware(): MessageMiddleware {
  return (next: MessageHandler): MessageHandler => {
    return async (message: BotMessage): Promise<void> => {
      // Ensure message ID
      if (!message.id) {
        message.id = generateId('msg');
      }

      // Trim content
      if (message.content) {
        message.content = message.content.trim();
      }

      // Ensure timestamp
      if (!message.timestamp) {
        message.timestamp = Date.now();
      }

      // Add traceId for request tracing
      if (!message.metadata.traceId) {
        message.metadata.traceId = generateTraceId();
      }

      // Sanitize userId
      if (message.userId) {
        message.userId = sanitizeUserId(message.userId);
      }

      logger.debug('消息规范化完成', {
        messageId: message.id,
        traceId: message.metadata.traceId,
        channel: message.channel,
      });

      return next(message);
    };
  };
}
