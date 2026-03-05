/**
 * Structured JSON Lines logger for MCP Servers.
 * Each server instance writes to its own .jsonl log file.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolExecutionLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  serverId: string;
  toolName: string;
  userId: string;
  traceId: string;
  durationMs: number;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class McpServerLogger {
  private logStream: ReturnType<typeof createWriteStream>;
  private readonly serverId: string;

  constructor(serverId: string, logDir?: string) {
    this.serverId = serverId;
    const dir = logDir ?? process.env.LOG_DIR ?? '/var/log/yourbot/mcp-servers';
    mkdirSync(dir, { recursive: true });
    this.logStream = createWriteStream(join(dir, `${serverId}.jsonl`), { flags: 'a' });
  }

  logToolExecution(log: ToolExecutionLog): void {
    const line = JSON.stringify(log) + '\n';
    this.logStream.write(line);

    if (log.level === 'error') {
      console.error(`[${log.serverId}] Tool '${log.toolName}' error: ${log.error}`);
    }
  }

  close(): void {
    this.logStream.end();
  }
}

/**
 * Tool execution wrapper that auto-logs invocations.
 */
export function withLogging<TInput, TOutput>(
  logger: McpServerLogger,
  serverId: string,
  toolName: string,
  handler: (input: TInput) => Promise<TOutput>,
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput) => {
    const startTime = Date.now();
    const userId = process.env.YOURBOT_USER_ID ?? 'unknown';
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    try {
      const result = await handler(input);
      logger.logToolExecution({
        timestamp: new Date().toISOString(),
        level: 'info',
        serverId,
        toolName,
        userId,
        traceId,
        durationMs: Date.now() - startTime,
        input: input as Record<string, unknown>,
        output: result,
      });
      return result;
    } catch (error) {
      logger.logToolExecution({
        timestamp: new Date().toISOString(),
        level: 'error',
        serverId,
        toolName,
        userId,
        traceId,
        durationMs: Date.now() - startTime,
        input: input as Record<string, unknown>,
        error: String(error),
      });
      throw error;
    }
  };
}
