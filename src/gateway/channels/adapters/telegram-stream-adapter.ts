import { StreamContentFilter } from '../../../kernel/streaming/stream-content-filter';
import type {
  ChannelStreamAdapter,
  StreamProtocol,
} from '../../../kernel/streaming/stream-protocol';
import { Logger } from '../../../shared/logging/logger';

export interface TelegramStreamDeps {
  sendMessage(chatId: number, text: string): Promise<number>; // returns messageId
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

const MAX_MESSAGE_CONTENT_LENGTH = 10000;

export class TelegramStreamAdapter implements ChannelStreamAdapter {
  readonly channelType = 'telegram';

  private readonly logger = new Logger('TelegramStreamAdapter');
  private readonly chatId: number;
  private readonly deps: TelegramStreamDeps;
  private readonly throttleMs: number;
  private readonly filter = new StreamContentFilter();

  private messageId?: number;
  private contentBuffer = ''; // Accumulates only text_delta content
  private statusLine: string | null = null; // Current tool status — not persisted to buffer
  private updateCount = 0;
  private lastUpdateTime = 0;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;

  constructor(chatId: number, deps: TelegramStreamDeps, throttleMs = 2000) {
    this.chatId = chatId;
    this.deps = deps;
    this.throttleMs = throttleMs;
  }

  async onStreamStart(_messageId: string): Promise<void> {
    this.contentBuffer = '';
    this.statusLine = null;
    this.messageId = undefined;
    this.updateCount = 0;
    this.lastUpdateTime = 0;
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

        if (this.contentBuffer.length > MAX_MESSAGE_CONTENT_LENGTH) {
          const keep = MAX_MESSAGE_CONTENT_LENGTH - 100;
          this.contentBuffer = `... (truncated)\n\n${this.contentBuffer.slice(-keep)}`;
        }
        break;
      }
    }

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

    // Final render: clean content only, no status line
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

    const errorText = this.contentBuffer
      ? `${this.contentBuffer}\n\n[Error: ${error}]`
      : `[Error: ${error}]`;

    if (this.messageId) {
      await this.deps.editMessage(this.chatId, this.messageId, errorText);
    } else {
      await this.deps.sendMessage(this.chatId, errorText);
    }
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
    if (!display) return;

    this.updateCount++;
    this.lastUpdateTime = Date.now();

    if (!this.messageId) {
      this.messageId = await this.deps.sendMessage(this.chatId, display);
    } else {
      await this.deps.editMessage(this.chatId, this.messageId, display);
    }
  }
}
