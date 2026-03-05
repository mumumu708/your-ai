import type {
  ChannelStreamAdapter,
  StreamProtocol,
} from '../../../kernel/streaming/stream-protocol';
import { Logger } from '../../../shared/logging/logger';

export interface FeishuStreamDeps {
  createStreamCard(chatId: string, text: string): Promise<string>;
  updateCard(
    messageId: string,
    text: string,
    options?: { showActions?: boolean; actions?: string[] },
  ): Promise<void>;
}

export class FeishuStreamAdapter implements ChannelStreamAdapter {
  readonly channelType = 'feishu';

  private readonly logger = new Logger('FeishuStreamAdapter');
  private readonly chatId: string;
  private readonly deps: FeishuStreamDeps;
  private readonly throttleMs: number;

  private cardMessageId?: string;
  private accumulatedText = '';
  private updateCount = 0;
  private lastUpdateTime = 0;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;

  constructor(chatId: string, deps: FeishuStreamDeps, throttleMs = 300) {
    this.chatId = chatId;
    this.deps = deps;
    this.throttleMs = throttleMs;
  }

  async onStreamStart(_messageId: string): Promise<void> {
    this.accumulatedText = '';
    this.cardMessageId = undefined;
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
      // Schedule a deferred update
      const delay = this.throttleMs - timeSinceLastUpdate;
      this.pendingUpdate = setTimeout(() => {
        this.pendingUpdate = null;
        this.flushUpdate().catch((err) => {
          this.logger.error('飞书延迟更新失败', { error: String(err) });
        });
      }, delay);
    }
  }

  async sendDone(finalText: string, _protocol: StreamProtocol): Promise<void> {
    // Cancel any pending throttled update
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }

    this.accumulatedText = finalText;

    if (!this.cardMessageId) {
      this.cardMessageId = await this.deps.createStreamCard(this.chatId, finalText);
    }

    const cardId = this.cardMessageId;
    if (!cardId) {
      this.logger.warn('飞书流式完成但无卡片ID', { chatId: this.chatId });
      return;
    }

    // Send final card with action buttons
    await this.deps.updateCard(cardId, finalText, {
      showActions: true,
      actions: ['复制', '重新生成', '继续追问'],
    });

    this.logger.info('飞书流式完成', {
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
      ? `${this.accumulatedText}\n\n[错误: ${error}]`
      : `[错误: ${error}]`;

    if (this.cardMessageId) {
      await this.deps.updateCard(this.cardMessageId, errorText);
    } else {
      await this.deps.createStreamCard(this.chatId, errorText);
    }
  }

  private async flushUpdate(): Promise<void> {
    if (!this.accumulatedText) return;

    this.updateCount++;
    this.lastUpdateTime = Date.now();

    if (!this.cardMessageId) {
      this.cardMessageId = await this.deps.createStreamCard(this.chatId, this.accumulatedText);
    } else {
      await this.deps.updateCard(this.cardMessageId, this.accumulatedText);
    }
  }
}
