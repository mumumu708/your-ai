import type { BotMessage, BotResponse, ChannelType, MessageHandler } from './bot-message.types';
import type { StreamEvent } from './stream-event.types';

export interface IChannel {
  readonly type: ChannelType;
  readonly name: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  sendMessage(userId: string, content: BotResponse): Promise<void>;
  updateMessage(messageId: string, content: BotResponse): Promise<void>;
  sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void>;
  onMessage(handler: MessageHandler): void;
  downloadFile?(messageId: string, fileKey: string): Promise<Buffer>;
}

export interface LayerHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface LayerContract {
  readonly upstream: {
    invoke: (message: BotMessage) => Promise<void>;
    healthCheck: () => Promise<LayerHealth>;
  };
  readonly downstream: {
    sendResponse: (channelId: string, response: BotResponse) => Promise<void>;
    pushStream: (channelId: string, event: StreamEvent) => void;
  };
}
