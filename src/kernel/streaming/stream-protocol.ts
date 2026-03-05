export type StreamProtocolType =
  | 'stream_start'
  | 'text_delta'
  | 'tool_start'
  | 'tool_result'
  | 'thinking'
  | 'error'
  | 'stream_end';

export interface StreamProtocol {
  type: StreamProtocolType;
  data: {
    text?: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    error?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };
  metadata: {
    messageId: string;
    sequenceNumber: number;
    timestamp: number;
  };
}

export interface ChannelStreamAdapter {
  readonly channelType: string;

  /** Called once when streaming begins */
  onStreamStart(messageId: string): Promise<void>;

  /** Called with accumulated/buffered text chunk */
  sendChunk(text: string, protocol: StreamProtocol): Promise<void>;

  /** Called once when streaming completes with the final full text */
  sendDone(finalText: string, protocol: StreamProtocol): Promise<void>;

  /** Called on error */
  sendError(error: string, protocol: StreamProtocol): Promise<void>;
}

export interface ThrottleConfig {
  intervalMs: number;
}

/**
 * Per-channel throttle configuration defaults.
 * Feishu: 300ms (card PATCH API rate limit)
 * Telegram: 2000ms (editMessage 30/minute limit)
 * Web: 0 (real-time WebSocket push)
 */
export const CHANNEL_THROTTLE_DEFAULTS: Record<string, ThrottleConfig> = {
  feishu: { intervalMs: 300 },
  telegram: { intervalMs: 2000 },
  web: { intervalMs: 0 },
};
