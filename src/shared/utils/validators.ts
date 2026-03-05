import type { BotMessage } from '../messaging/bot-message.types';

export function isValidBotMessage(message: unknown): message is BotMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const msg = message as Record<string, unknown>;
  return (
    typeof msg.id === 'string' &&
    typeof msg.channel === 'string' &&
    typeof msg.userId === 'string' &&
    typeof msg.userName === 'string' &&
    typeof msg.conversationId === 'string' &&
    typeof msg.content === 'string' &&
    typeof msg.contentType === 'string' &&
    typeof msg.timestamp === 'number' &&
    typeof msg.metadata === 'object' &&
    msg.metadata !== null
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
