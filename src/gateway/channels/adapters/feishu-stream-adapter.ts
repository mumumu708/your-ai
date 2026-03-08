import type {
  ChannelStreamAdapter,
  StreamProtocol,
} from '../../../kernel/streaming/stream-protocol';
import { Logger } from '../../../shared/logging/logger';

export interface FeishuStreamDeps {
  createStreamingCard(initialText: string): Promise<string>;
  sendCardMessage(chatId: string, cardId: string): Promise<string>;
  streamUpdateText(
    cardId: string,
    elementId: string,
    fullText: string,
    sequence: number,
  ): Promise<void>;
  closeStreamingMode(cardId: string, sequence: number): Promise<void>;
  addActionButtons(
    cardId: string,
    afterElementId: string,
    buttons: string[],
    sequence: number,
  ): Promise<void>;
  sendTextMessage(chatId: string, text: string): Promise<void>;
}

const CONTENT_ELEMENT_ID = 'md_content';
const MAX_CARD_CONTENT_LENGTH = 28000;

export class FeishuStreamAdapter implements ChannelStreamAdapter {
  readonly channelType = 'feishu';

  private readonly logger = new Logger('FeishuStreamAdapter');
  private readonly chatId: string;
  private readonly deps: FeishuStreamDeps;
  private readonly throttleMs: number;

  private cardId?: string;
  private accumulatedText = '';
  private updateCount = 0;
  private lastUpdateTime = 0;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  private sequenceCounter = 0;
  private fallbackMode = false;

  constructor(chatId: string, deps: FeishuStreamDeps, throttleMs = 100) {
    this.chatId = chatId;
    this.deps = deps;
    this.throttleMs = throttleMs;
  }

  async onStreamStart(_messageId: string): Promise<void> {
    this.accumulatedText = '';
    this.cardId = undefined;
    this.updateCount = 0;
    this.lastUpdateTime = 0;
    this.sequenceCounter = 0;
    this.fallbackMode = false;

    try {
      this.cardId = await this.deps.createStreamingCard('思考中...');
      await this.deps.sendCardMessage(this.chatId, this.cardId);
    } catch (err) {
      this.logger.warn('CardKit 创建失败，降级为文本模式', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.fallbackMode = true;
    }
  }

  async sendChunk(text: string, _protocol: StreamProtocol): Promise<void> {
    this.accumulatedText += text;

    if (this.accumulatedText.length > MAX_CARD_CONTENT_LENGTH) {
      const keep = MAX_CARD_CONTENT_LENGTH - 100;
      this.accumulatedText = `... (内容已截断)\n\n${this.accumulatedText.slice(-keep)}`;
    }

    if (this.fallbackMode) return;

    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    if (timeSinceLastUpdate >= this.throttleMs) {
      await this.flushUpdate();
    } else if (!this.pendingUpdate) {
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
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }

    const displayText = finalText || '（无响应内容）';
    this.accumulatedText = displayText;

    if (this.fallbackMode) {
      await this.deps.sendTextMessage(this.chatId, displayText);
      return;
    }

    if (!this.cardId) {
      await this.deps.sendTextMessage(this.chatId, displayText);
      return;
    }

    // Final text update
    this.sequenceCounter++;
    await this.deps.streamUpdateText(
      this.cardId,
      CONTENT_ELEMENT_ID,
      displayText,
      this.sequenceCounter,
    );

    // Close streaming mode
    this.sequenceCounter++;
    await this.deps.closeStreamingMode(this.cardId, this.sequenceCounter);

    // Add action buttons
    this.sequenceCounter++;
    await this.deps.addActionButtons(
      this.cardId,
      CONTENT_ELEMENT_ID,
      ['复制', '重新生成', '继续追问'],
      this.sequenceCounter,
    );

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

    if (this.fallbackMode || !this.cardId) {
      await this.deps.sendTextMessage(this.chatId, errorText);
      return;
    }

    // Update card with error text then close streaming
    this.sequenceCounter++;
    await this.deps.streamUpdateText(
      this.cardId,
      CONTENT_ELEMENT_ID,
      errorText,
      this.sequenceCounter,
    );

    this.sequenceCounter++;
    await this.deps.closeStreamingMode(this.cardId, this.sequenceCounter);
  }

  private async flushUpdate(): Promise<void> {
    if (!this.accumulatedText || !this.cardId) return;

    this.updateCount++;
    this.lastUpdateTime = Date.now();
    this.sequenceCounter++;

    await this.deps.streamUpdateText(
      this.cardId,
      CONTENT_ELEMENT_ID,
      this.accumulatedText,
      this.sequenceCounter,
    );
  }
}
