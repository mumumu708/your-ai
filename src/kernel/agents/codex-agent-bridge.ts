import { spawn } from 'node:child_process';

import { Logger } from '../../shared/logging/logger';
import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';

const logger = new Logger('CodexAgentBridge');

/** Default execution timeout: 120 seconds */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * CodexAgentBridge — 通过 Codex CLI 执行 agent 会话。
 *
 * 使用 `codex exec` 非交互模式 + `--json` JSONL 输出。
 * 支持流式回调、AbortSignal 取消、工作目录设置。
 */
export class CodexAgentBridge implements AgentBridge {
  private readonly timeoutMs: number;

  constructor(config?: { timeoutMs?: number }) {
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    const args = this.buildArgs(params);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = () => {
        settled = true;
        clearTimeout(timer);
      };

      const proc = spawn('codex', args, {
        cwd: params.workspacePath || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'], // stdin must be closed — codex waits for EOF
      });

      // Execution timeout — kill process if it doesn't exit in time
      const timer = setTimeout(() => {
        if (!settled) {
          logger.warn('Codex CLI 执行超时，终止进程', { timeoutMs: this.timeoutMs });
          proc.kill('SIGTERM');
          if (params.streamCallback) {
            void params.streamCallback({ type: 'done' });
          }
          settled = true;
          reject(new Error(`Codex CLI timeout after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      let stdout = '';
      let stderr = '';
      let lineBuffer = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        // Parse JSONL events for streaming — handle buffer boundaries
        if (params.streamCallback) {
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          // Keep last (possibly incomplete) line in buffer
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              const item = event.item as Record<string, unknown> | undefined;
              // Codex JSONL format: { type: "item.completed", item: { type: "agent_message", text: "..." } }
              if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
                void params.streamCallback({ type: 'text_delta', text: item.text as string });
              }
            } catch {
              /* ignore non-JSON lines (e.g. stderr leaks) */
            }
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      if (params.signal) {
        params.signal.addEventListener(
          'abort',
          () => {
            if (!settled) {
              proc.kill('SIGTERM');
            }
          },
          { once: true },
        );
      }

      proc.on('close', (code) => {
        if (settled) return;
        settle();

        if (code !== 0 && code !== null) {
          if (params.streamCallback) {
            void params.streamCallback({ type: 'done' });
          }
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Extract final content from JSONL output
        const content = this.extractContent(stdout);

        logger.info('Codex CLI 执行完成', { contentLength: content.length });

        if (params.streamCallback) {
          void params.streamCallback({ type: 'done' });
        }

        resolve({
          content,
          tokenUsage: { inputTokens: 0, outputTokens: 0 }, // Codex doesn't expose token usage easily
          finishedNaturally: code === 0,
          handledBy: 'codex',
        });
      });

      proc.on('error', (err) => {
        if (settled) return;
        settle();
        if (params.streamCallback) {
          void params.streamCallback({ type: 'done' });
        }
        reject(err);
      });
    });
  }

  buildArgs(params: AgentExecuteParams): string[] {
    const args = ['exec'];

    // Full auto mode
    args.push('--full-auto');

    // JSONL output
    args.push('--json');

    // Skip git repo trust check — server process runs in arbitrary cwd
    args.push('--skip-git-repo-check');

    // Working directory
    if (params.workspacePath) {
      args.push('-C', params.workspacePath);
    }

    // System prompt as part of the message
    const fullPrompt = [params.systemPrompt, params.prependContext, params.userMessage]
      .filter(Boolean)
      .join('\n\n');
    args.push(fullPrompt);

    return args;
  }

  extractContent(jsonlOutput: string): string {
    // Parse JSONL, collect all agent_message texts
    const lines = jsonlOutput.split('\n').filter(Boolean);
    const messages: string[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const item = event.item as Record<string, unknown> | undefined;
        // Codex JSONL: { type: "item.completed", item: { type: "agent_message", text: "..." } }
        if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
          messages.push(item.text as string);
        }
      } catch {
        /* ignore */
      }
    }

    return messages.join('\n\n') || jsonlOutput.trim();
  }
}
