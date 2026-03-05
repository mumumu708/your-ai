import { Logger } from '../../shared/logging/logger';
import type {
  BotMessage,
  BotResponse,
  ChannelType,
  IChannel,
  MessageHandler,
  StreamEvent,
} from '../../shared/messaging';

export abstract class BaseChannel implements IChannel {
  abstract readonly type: ChannelType;
  abstract readonly name: string;

  protected readonly logger: Logger;
  protected messageHandler?: MessageHandler;

  constructor(logModule: string) {
    this.logger = new Logger(logModule);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  protected async emitMessage(message: BotMessage): Promise<void> {
    if (!this.messageHandler) {
      this.logger.warn('收到消息但未注册处理器', { messageId: message.id });
      return;
    }
    await this.messageHandler(message);
  }

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;
  abstract sendMessage(userId: string, content: BotResponse): Promise<void>;
  abstract updateMessage(messageId: string, content: BotResponse): Promise<void>;
  abstract sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void>;
  abstract transformToStandardMessage(rawMessage: unknown): Promise<BotMessage>;
}
