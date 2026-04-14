import { StreamContentFilter } from '../../../kernel/streaming/stream-content-filter';
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
  private readonly filter = new StreamContentFilter();

  private cardId?: string;
  private contentBuffer = ''; // Accumulates only text_delta content
  private statusLine: string | null = null; // Current tool status — not persisted to buffer
  private updateCount = 0;
  private lastUpdateTime = 0;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  private sequenceCounter = 0;
  private fallbackMode = false;

  /** Pre-created card ID from placeholder — skips card creation in onStreamStart */
  private readonly existingCardId?: string;

  constructor(chatId: string, deps: FeishuStreamDeps, throttleMs = 300, existingCardId?: string) {
    this.chatId = chatId;
    this.deps = deps;
    this.throttleMs = throttleMs;
    this.existingCardId = existingCardId;
  }

  async onStreamStart(_messageId: string): Promise<void> {
    this.contentBuffer = '';
    this.statusLine = null;
    this.cardId = undefined;
    this.updateCount = 0;
    this.lastUpdateTime = 0;
    this.sequenceCounter = 0;
    this.fallbackMode = false;

    // Reuse pre-created placeholder card if available (DD-021)
    if (this.existingCardId) {
      this.cardId = this.existingCardId;
      return;
    }

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

  async sendChunk(text: string, protocol: StreamProtocol): Promise<void> {
    switch (protocol.type) {
      case 'tool_start': {
        // Show a one-line status summary instead of accumulating raw tool text
        const filtered = this.filter.filter({
          type: 'tool_use',
          toolName: protocol.data.toolName,
        });
        if (filtered) {
          this.statusLine = filtered.text;
        }
        break;
      }

      case 'tool_result': {
        // Suppress tool results — text content follows via text_delta
        return;
      }

      default: {
        // text_delta (and any unrecognised types): accumulate content, clear status line
        this.contentBuffer += text;
        this.statusLine = null;

        if (this.contentBuffer.length > MAX_CARD_CONTENT_LENGTH) {
          const keep = MAX_CARD_CONTENT_LENGTH - 100;
          this.contentBuffer = `... (内容已截断)\n\n${this.contentBuffer.slice(-keep)}`;
        }
        break;
      }
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

    // Final render: clean content only, status line cleared
    const displayText = finalText || '（无响应内容）';

    if (this.fallbackMode) {
      await this.deps.sendTextMessage(this.chatId, displayText);
      return;
    }

    if (!this.cardId) {
      await this.deps.sendTextMessage(this.chatId, displayText);
      return;
    }

    this.sequenceCounter++;
    await this.deps.streamUpdateText(
      this.cardId,
      CONTENT_ELEMENT_ID,
      displayText,
      this.sequenceCounter,
    );

    this.sequenceCounter++;
    await this.deps.closeStreamingMode(this.cardId, this.sequenceCounter);

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

    const errorText = this.contentBuffer
      ? `${this.contentBuffer}\n\n[错误: ${error}]`
      : `[错误: ${error}]`;

    if (this.fallbackMode || !this.cardId) {
      await this.deps.sendTextMessage(this.chatId, errorText);
      return;
    }

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

  /** Combines content buffer with active status line for streaming display. */
  private buildDisplay(): string {
    if (this.contentBuffer && this.statusLine) {
      return `${this.contentBuffer}\n\n${this.statusLine}`;
    }
    return this.contentBuffer || this.statusLine || '';
  }

  private async flushUpdate(): Promise<void> {
    const display = this.buildDisplay();
    if (!display || !this.cardId) return;

    this.updateCount++;
    this.lastUpdateTime = Date.now();
    this.sequenceCounter++;

    await this.deps.streamUpdateText(
      this.cardId,
      CONTENT_ELEMENT_ID,
      display,
      this.sequenceCounter,
    );
  }
}
