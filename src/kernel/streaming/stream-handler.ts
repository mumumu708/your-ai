import { Logger } from '../../shared/logging/logger';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import { generateId } from '../../shared/utils/crypto';
import { StreamBuffer, type StreamBufferOptions } from './stream-buffer';
import type { ChannelStreamAdapter, StreamProtocol } from './stream-protocol';

export interface StreamHandlerOptions {
  buffer?: StreamBufferOptions;
}

export interface StreamResult {
  fullContent: string;
  totalChunks: number;
  durationMs: number;
}

export class StreamHandler {
  private readonly logger = new Logger('StreamHandler');

  constructor(private readonly options: StreamHandlerOptions = {}) {}

  /**
   * Process a stream of events and distribute to channel adapters.
   * This is the core streaming pipeline:
   *   Source (AsyncIterable<StreamEvent>) → StreamBuffer → ChannelStreamAdapter[]
   */
  async processStream(
    source: AsyncIterable<StreamEvent>,
    adapters: ChannelStreamAdapter[],
  ): Promise<StreamResult> {
    const messageId = generateId('smsg');
    const startTime = Date.now();
    const buffer = new StreamBuffer(this.options.buffer);
    let fullContent = '';
    let sequenceNumber = 0;
    let totalChunks = 0;

    // Notify all adapters of stream start
    await Promise.allSettled(adapters.map((a) => a.onStreamStart(messageId)));

    try {
      for await (const event of source) {
        switch (event.type) {
          case 'text_delta': {
            if (event.text) {
              fullContent += event.text;
              buffer.append(event.text);

              if (buffer.shouldFlush()) {
                const chunk = buffer.flush();
                sequenceNumber++;
                totalChunks++;
                const protocol = this.buildProtocol('text_delta', messageId, sequenceNumber, {
                  text: chunk,
                });
                await this.distributeToAdapters(adapters, 'chunk', chunk, protocol);
              }
            }
            break;
          }

          case 'tool_use': {
            // Flush buffer before tool events
            const remaining = buffer.forceFlush();
            if (remaining) {
              sequenceNumber++;
              totalChunks++;
              const flushProtocol = this.buildProtocol('text_delta', messageId, sequenceNumber, {
                text: remaining,
              });
              await this.distributeToAdapters(adapters, 'chunk', remaining, flushProtocol);
            }

            sequenceNumber++;
            const toolProtocol = this.buildProtocol('tool_start', messageId, sequenceNumber, {
              toolName: event.toolName,
              toolInput: JSON.stringify(event.toolInput),
            });
            const hint = this.extractToolHint(event.toolName, event.toolInput);
            const label = hint
              ? `\n> 🔧 ${event.toolName}：${hint}\n`
              : `\n> 🔧 调用 ${event.toolName} ...\n`;
            await this.distributeToAdapters(adapters, 'chunk', label, toolProtocol);
            break;
          }

          case 'tool_result': {
            sequenceNumber++;
            const resultProtocol = this.buildProtocol('tool_result', messageId, sequenceNumber, {
              toolName: event.toolName,
              toolResult: event.text,
            });
            await this.distributeToAdapters(adapters, 'chunk', '> ✅ 完成\n\n', resultProtocol);
            break;
          }

          case 'error': {
            sequenceNumber++;
            const errorProtocol = this.buildProtocol('error', messageId, sequenceNumber, {
              error: event.error,
            });
            await Promise.allSettled(
              adapters.map((a) => a.sendError(event.error ?? 'Unknown error', errorProtocol)),
            );
            break;
          }

          case 'done': {
            // Flush any remaining buffered content
            const finalRemaining = buffer.forceFlush();
            if (finalRemaining) {
              sequenceNumber++;
              totalChunks++;
              const flushProtocol = this.buildProtocol('text_delta', messageId, sequenceNumber, {
                text: finalRemaining,
              });
              await this.distributeToAdapters(adapters, 'chunk', finalRemaining, flushProtocol);
            }

            sequenceNumber++;
            const doneProtocol = this.buildProtocol('stream_end', messageId, sequenceNumber, {});
            await Promise.allSettled(adapters.map((a) => a.sendDone(fullContent, doneProtocol)));
            break;
          }
        }
      }
    } catch (error) {
      this.logger.error('流式处理错误', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Flush remaining buffer and send error
      const errRemaining = buffer.forceFlush();
      if (errRemaining) {
        fullContent += ''; // already accumulated
      }

      sequenceNumber++;
      const errorProtocol = this.buildProtocol('error', messageId, sequenceNumber, {
        error: error instanceof Error ? error.message : String(error),
      });
      await Promise.allSettled(
        adapters.map((a) =>
          a.sendError(error instanceof Error ? error.message : String(error), errorProtocol),
        ),
      );
    }

    const durationMs = Date.now() - startTime;
    this.logger.info('流式处理完成', {
      messageId,
      contentLength: fullContent.length,
      totalChunks,
      durationMs,
    });

    return { fullContent, totalChunks, durationMs };
  }

  /**
   * Create a StreamEvent callback that feeds into processStream.
   * Useful for integrating with AgentRuntime's streamCallback pattern.
   */
  createStreamCallback(adapters: ChannelStreamAdapter[]): {
    callback: (event: StreamEvent) => void;
    result: Promise<StreamResult>;
  } {
    const events: StreamEvent[] = [];
    let resolveIterator: (() => void) | null = null;
    let done = false;

    const iterator: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            while (events.length === 0 && !done) {
              await new Promise<void>((resolve) => {
                resolveIterator = resolve;
              });
            }
            if (events.length > 0) {
              return { value: events.shift() as StreamEvent, done: false };
            }
            return { value: undefined as unknown as StreamEvent, done: true };
          },
        };
      },
    };

    const callback = (event: StreamEvent): void => {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') {
        done = true;
      }
      resolveIterator?.();
    };

    const result = this.processStream(iterator, adapters);

    return { callback, result };
  }

  private async distributeToAdapters(
    adapters: ChannelStreamAdapter[],
    _type: 'chunk',
    text: string,
    protocol: StreamProtocol,
  ): Promise<void> {
    await Promise.allSettled(adapters.map((a) => a.sendChunk(text, protocol)));
  }

  /**
   * Extract a short hint from toolInput for display.
   * Returns null if no meaningful hint can be extracted.
   */
  private extractToolHint(toolName?: string, toolInput?: unknown): string | null {
    if (!toolInput || typeof toolInput !== 'object') return null;
    const input = toolInput as Record<string, unknown>;
    const MAX_HINT = 60;
    const truncate = (s: string): string => (s.length > MAX_HINT ? `${s.slice(0, MAX_HINT)}…` : s);

    // File operation tools
    if (input.file_path && typeof input.file_path === 'string') {
      return truncate(input.file_path);
    }
    // Bash / shell commands
    if (input.command && typeof input.command === 'string') {
      return truncate(input.command);
    }
    // Search tools (Grep / search_for_pattern)
    if (input.pattern && typeof input.pattern === 'string') {
      return truncate(input.pattern);
    }
    if (input.substring_pattern && typeof input.substring_pattern === 'string') {
      return truncate(input.substring_pattern);
    }
    // Glob
    if (input.glob && typeof input.glob === 'string') {
      return truncate(input.glob);
    }
    // Skill
    if (input.skill && typeof input.skill === 'string') {
      return input.skill;
    }
    // WebSearch
    if (input.query && typeof input.query === 'string') {
      return truncate(input.query);
    }
    // WebFetch
    if (input.url && typeof input.url === 'string') {
      return truncate(input.url);
    }
    // MCP / serena tools — relative_path or name_path
    if (input.relative_path && typeof input.relative_path === 'string') {
      return truncate(input.relative_path);
    }
    if (input.name_path_pattern && typeof input.name_path_pattern === 'string') {
      return truncate(input.name_path_pattern);
    }
    if (input.name_path && typeof input.name_path === 'string') {
      return truncate(input.name_path);
    }
    // Agent tool
    if (toolName === 'Agent' && input.description && typeof input.description === 'string') {
      return truncate(input.description);
    }

    return null;
  }

  private buildProtocol(
    type: StreamProtocol['type'],
    messageId: string,
    sequenceNumber: number,
    data: Partial<StreamProtocol['data']>,
  ): StreamProtocol {
    return {
      type,
      data: {
        text: data.text,
        toolName: data.toolName,
        toolInput: data.toolInput,
        toolResult: data.toolResult,
        error: data.error,
        usage: data.usage,
      },
      metadata: {
        messageId,
        sequenceNumber,
        timestamp: Date.now(),
      },
    };
  }
}
