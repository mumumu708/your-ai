import { spawn } from 'node:child_process';

import { Logger } from '../../shared/logging/logger';
import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';

const logger = new Logger('OpenCodeAgentBridge');

/**
 * OpenCodeAgentBridge — 通过 OpenCode CLI 执行 agent 会话。
 *
 * 使用 `opencode` 非交互模式。
 * 支持流式回调、AbortSignal 取消、工作目录设置。
 */
export class OpenCodeAgentBridge implements AgentBridge {
  private readonly opencodePath: string;

  constructor(config?: { opencodePath?: string }) {
    this.opencodePath = config?.opencodePath ?? 'opencode';
  }

  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    const args = this.buildArgs(params);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.opencodePath, args, {
        cwd: params.workspacePath || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'], // stdin must be closed — CLI may wait for EOF
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        if (params.streamCallback) {
          void params.streamCallback({ type: 'text_delta', text });
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
          reject(new Error(`OpenCode CLI exited with code ${code}: ${stderr}`));
          return;
        }

        const content = stdout.trim();
        logger.info('OpenCode CLI 执行完成', { contentLength: content.length });

        if (params.streamCallback) {
          void params.streamCallback({ type: 'done' });
        }

        resolve({
          content,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          finishedNaturally: code === 0,
          handledBy: 'opencode',
        });
      });

      proc.on('error', (err) => reject(err));
    });
  }

  buildArgs(params: AgentExecuteParams): string[] {
    const args: string[] = ['--quiet', '--prompt'];

    // Combine system prompt, prepend context, and user message
    const fullPrompt = [params.systemPrompt, params.prependContext, params.userMessage]
      .filter(Boolean)
      .join('\n\n');
    args.push(fullPrompt);

    if (params.workspacePath) {
      args.push('-C', params.workspacePath);
    }

    return args;
  }
}
