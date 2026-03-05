import type {
  ChannelStreamAdapter,
  StreamProtocol,
} from '../../../kernel/streaming/stream-protocol';
import { Logger } from '../../../shared/logging/logger';

export interface WebStreamDeps {
  sendJson(userId: string, data: unknown): void;
}

export class WebStreamAdapter implements ChannelStreamAdapter {
  readonly channelType = 'web';

  private readonly logger = new Logger('WebStreamAdapter');
  private readonly userId: string;
  private readonly deps: WebStreamDeps;

  constructor(userId: string, deps: WebStreamDeps) {
    this.userId = userId;
    this.deps = deps;
  }

  async onStreamStart(messageId: string): Promise<void> {
    this.deps.sendJson(this.userId, {
      type: 'stream_start',
      messageId,
      timestamp: Date.now(),
    });
  }

  async sendChunk(text: string, protocol: StreamProtocol): Promise<void> {
    this.deps.sendJson(this.userId, {
      type: 'stream',
      data: {
        type: protocol.type,
        text,
        toolName: protocol.data.toolName,
        toolInput: protocol.data.toolInput,
      },
      metadata: protocol.metadata,
    });
  }

  async sendDone(finalText: string, protocol: StreamProtocol): Promise<void> {
    this.deps.sendJson(this.userId, {
      type: 'stream_end',
      data: {
        text: finalText,
        usage: protocol.data.usage,
      },
      metadata: protocol.metadata,
    });
  }

  async sendError(error: string, protocol: StreamProtocol): Promise<void> {
    this.deps.sendJson(this.userId, {
      type: 'stream_error',
      data: { error },
      metadata: protocol.metadata,
    });
  }
}
