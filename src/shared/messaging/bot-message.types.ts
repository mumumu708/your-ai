export type ChannelType = 'feishu' | 'telegram' | 'web' | 'api';

export type ContentType = 'text' | 'image' | 'file' | 'audio' | 'command';

export interface BotMessage {
  id: string;
  channel: ChannelType;
  userId: string;
  userName: string;
  conversationId: string;
  content: string;
  contentType: ContentType;
  timestamp: number;
  metadata: Record<string, unknown>;
  replyTo?: string;
}

export interface BotResponse {
  type: string;
  text?: string;
  payload?: unknown;
}

export type MessageHandler = (message: BotMessage) => Promise<void>;
