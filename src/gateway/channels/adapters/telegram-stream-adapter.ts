import type {
  ChannelStreamAdapter,
  StreamProtocol,
} from '../../../kernel/streaming/stream-protocol';
import { Logger } from '../../../shared/logging/logger';

export interface TelegramStreamDeps {
  sendMessage(chatId: number, text: string): Promise<number>; // returns messageId
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

export class TelegramStreamAdapter implements ChannelStreamAdapter {
  readonly channelType = 'telegram';

  private readonly logger = new Logger('TelegramStreamAdapter');
  private readonly chatId: number;
  private readonly deps: TelegramStreamDeps;
  private readonly throttleMs: number;

  private messageId?: number;
  private accumulatedText = '';
  private updateCount = 0;
  private lastUpdateTime = 0;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;

  constructor(chatId: number, deps: TelegramStreamDeps, throttleMs = 2000) {
    this.chatId = chatId;
    this.deps = deps;
    this.throttleMs = throttleMs;
  }

  async onStreamStart(_messageId: string): Promise<void> {
    this.accumulatedText = '';
    this.messageId = undefined;
    this.updateCount = 0;
    this.lastUpdateTime = 0;
  }

  async sendChunk(text: string, _protocol: StreamProtocol): Promise<void> {
    this.accumulatedText += text;

    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    if (timeSinceLastUpdate >= this.throttleMs) {
      await this.flushUpdate();
    } else if (!this.pendingUpdate) {
      const delay = this.throttleMs - timeSinceLastUpdate;
      this.pendingUpdate = setTimeout(() => {
        this.pendingUpdate = null;
        this.flushUpdate().catch((err) => {
          this.logger.error('Telegram 延迟更新失败', { error: String(err) });
        });
      }, delay);
    }
  }

  async sendDone(finalText: string, _protocol: StreamProtocol): Promise<void> {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }

    this.accumulatedText = finalText;

    if (!this.messageId) {
      this.messageId = await this.deps.sendMessage(this.chatId, finalText);
    } else {
      await this.deps.editMessage(this.chatId, this.messageId, finalText);
    }

    this.logger.info('Telegram 流式完成', {
      chatId: this.chatId,
      updateCount: this.updateCount,
      contentLength: finalText.length,
    });
  }

  async sendError(error: string, _protocol: StreamProtocol): Promise<void> {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }

    const errorText = this.accumulatedText
      ? `${this.accumulatedText}\n\n[Error: ${error}]`
      : `[Error: ${error}]`;

    if (this.messageId) {
      await this.deps.editMessage(this.chatId, this.messageId, errorText);
    } else {
      await this.deps.sendMessage(this.chatId, errorText);
    }
  }

  private async flushUpdate(): Promise<void> {
    if (!this.accumulatedText) return;

    this.updateCount++;
    this.lastUpdateTime = Date.now();

    if (!this.messageId) {
      this.messageId = await this.deps.sendMessage(this.chatId, this.accumulatedText);
    } else {
      await this.deps.editMessage(this.chatId, this.messageId, this.accumulatedText);
    }
  }
}
