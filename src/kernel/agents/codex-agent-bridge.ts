import { spawn } from 'node:child_process';

import { Logger } from '../../shared/logging/logger';
import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';

const logger = new Logger('CodexAgentBridge');

/**
 * CodexAgentBridge — 通过 Codex CLI 执行 agent 会话。
 *
 * 使用 `codex exec` 非交互模式 + `--json` JSONL 输出。
 * 支持流式回调、AbortSignal 取消、工作目录设置。
 */
export class CodexAgentBridge implements AgentBridge {
  // biome-ignore lint/complexity/noUselessConstructor: explicit for bun coverage
  constructor() {}

  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    const args = this.buildArgs(params);

    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
        cwd: params.workspacePath || process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        // Parse JSONL events for streaming
        if (params.streamCallback) {
          for (const line of text.split('\n').filter(Boolean)) {
            try {
              const event = JSON.parse(line) as { type?: string; role?: string; content?: string };
              if (event.type === 'message' && event.role === 'assistant') {
                void params.streamCallback({ type: 'text_delta', text: event.content || '' });
              }
            } catch {
              /* ignore non-JSON lines */
            }
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      if (params.signal) {
        params.signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });
      }

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Extract final content from JSONL output
        const content = this.extractContent(stdout);

        logger.info('Codex CLI 执行完成', { contentLength: content.length });

        resolve({
          content,
          tokenUsage: { inputTokens: 0, outputTokens: 0 }, // Codex doesn't expose token usage easily
          finishedNaturally: code === 0,
          handledBy: 'codex',
        });
      });

      proc.on('error', (err) => reject(err));
    });
  }

  buildArgs(params: AgentExecuteParams): string[] {
    const args = ['exec'];

    // Full auto mode
    args.push('--full-auto');

    // JSONL output
    args.push('--json');

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
    // Parse JSONL, find last assistant message
    const lines = jsonlOutput.split('\n').filter(Boolean);
    let lastContent = '';

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { type?: string; role?: string; content?: string };
        if (event.type === 'message' && event.role === 'assistant' && event.content) {
          lastContent = event.content;
        }
      } catch {
        /* ignore */
      }
    }

    return lastContent || jsonlOutput.trim();
  }
}
