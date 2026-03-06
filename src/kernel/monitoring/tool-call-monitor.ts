import { Logger } from '../../shared/logging/logger';

// --- Types ---

export interface ToolCallEvent {
  sessionId: string;
  toolName: string;
  serverId: string;
  input: Record<string, unknown>;
  output?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'started' | 'success' | 'error';
  errorMessage?: string;
}

export interface ToolCallStats {
  total: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  consecutiveErrors: number;
}

/**
 * Stream event shape from Claude Code's stream-json output.
 * Simplified to the fields we care about for monitoring.
 */
export interface ClaudeStreamEvent {
  type: string;
  content_block?: {
    type: string;
    id: string;
    name: string;
  };
  /** Block ID for content_block_stop events */
  id?: string;
  /** For tool_result events */
  is_error?: boolean;
  content?: string;
}

export interface ToolCallLogSink {
  persist(event: ToolCallEvent): Promise<void>;
}

// --- Monitor ---

export class ToolCallMonitor {
  private readonly logger = new Logger('ToolCallMonitor');
  private readonly activeToolCalls = new Map<string, ToolCallEvent>();
  private readonly completedEvents: ToolCallEvent[] = [];
  private readonly logSink: ToolCallLogSink | null;
  private consecutiveErrors = 0;

  constructor(logSink?: ToolCallLogSink) {
    this.logSink = logSink ?? null;
  }

  /**
   * Process a stream event from Claude Code's stream-json output.
   * Extracts tool_use start/stop events and tracks metrics.
   */
  processStreamEvent(sessionId: string, event: ClaudeStreamEvent): void {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const toolCall: ToolCallEvent = {
        sessionId,
        toolName: event.content_block.name,
        serverId: this.extractServerId(event.content_block.name),
        input: {},
        startTime: Date.now(),
        status: 'started',
      };
      this.activeToolCalls.set(event.content_block.id, toolCall);
      this.logger.info('工具调用开始', {
        sessionId,
        tool: toolCall.toolName,
        server: toolCall.serverId,
      });
    }

    if (event.type === 'content_block_stop' && event.id) {
      const toolCall = this.activeToolCalls.get(event.id);
      if (toolCall) {
        toolCall.endTime = Date.now();
        toolCall.durationMs = toolCall.endTime - toolCall.startTime;
        toolCall.status = 'success';
        this.consecutiveErrors = 0;

        this.completedEvents.push(toolCall);
        this.activeToolCalls.delete(event.id);

        this.logger.info('工具调用完成', {
          tool: toolCall.toolName,
          durationMs: toolCall.durationMs,
        });

        if (this.logSink) {
          this.logSink.persist(toolCall).catch(() => {});
        }
      }
    }

    if (event.type === 'tool_result' && event.is_error) {
      const toolCall = this.findActiveToolCall();
      if (toolCall) {
        toolCall.endTime = Date.now();
        toolCall.durationMs = toolCall.endTime - toolCall.startTime;
        toolCall.status = 'error';
        toolCall.errorMessage = event.content;
        this.consecutiveErrors++;

        this.completedEvents.push(toolCall);

        this.logger.error('工具调用失败', {
          tool: toolCall.toolName,
          error: event.content,
        });

        if (this.logSink) {
          this.logSink.persist(toolCall).catch(() => {});
        }
      }
    }
  }

  /**
   * Extract Server ID from MCP tool name.
   * Format: mcp__{serverId}__{toolName}
   */
  extractServerId(fullToolName: string): string {
    const match = fullToolName.match(/^mcp__(.+?)__(.+)$/);
    return match?.[1] ?? 'unknown';
  }

  /**
   * Get aggregated stats for monitoring and alerting.
   */
  getStats(): ToolCallStats {
    const total = this.completedEvents.length;
    const errorCount = this.completedEvents.filter((e) => e.status === 'error').length;
    const successCount = total - errorCount;
    const durations = this.completedEvents
      .filter((e): e is typeof e & { durationMs: number } => e.durationMs != null)
      .map((e) => e.durationMs);
    const avgDurationMs =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    return {
      total,
      successCount,
      errorCount,
      errorRate: total > 0 ? errorCount / total : 0,
      avgDurationMs,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  getActiveCallCount(): number {
    return this.activeToolCalls.size;
  }

  getCompletedEvents(): readonly ToolCallEvent[] {
    return this.completedEvents;
  }

  private findActiveToolCall(): ToolCallEvent | undefined {
    for (const [, tc] of this.activeToolCalls) {
      if (tc.status === 'started') return tc;
    }
    return undefined;
  }
}
