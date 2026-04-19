import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '../../shared/logging/logger';
import type { MediaRef } from '../../shared/messaging/media-attachment.types';
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
    // Write media to temp files for --image flag
    let tempDir: string | undefined;
    let imagePaths: string[] = [];
    if (params.mediaRefs?.length) {
      const written = this.writeMediaTempFiles(params.mediaRefs);
      tempDir = written.tempDir;
      imagePaths = written.paths;
    }

    const args = this.buildArgs(params, imagePaths);

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

        // Clean up temp image files
        if (tempDir) {
          void rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
        if (tempDir) {
          void rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
        if (params.streamCallback) {
          void params.streamCallback({ type: 'done' });
        }
        reject(err);
      });
    });
  }

  buildArgs(params: AgentExecuteParams, imagePaths: string[] = []): string[] {
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

    // Inject MCP servers via -c overrides
    // Codex reads MCP config from ~/.codex/config.toml; we override per-invocation
    if (params.mcpConfig?.mcpServers?.length) {
      for (const server of params.mcpConfig.mcpServers) {
        const key = `mcp_servers.${server.name}`;
        args.push('-c', `${key}.command="${server.command}"`);
        if (server.args && server.args.length > 0) {
          const argsArr = JSON.stringify(server.args);
          args.push('-c', `${key}.args=${argsArr}`);
        }
        if (server.env && Object.keys(server.env).length > 0) {
          // TOML inline table: { KEY = "value", ... }
          const envPairs = Object.entries(server.env)
            .map(([k, v]) => `${k} = "${String(v).replace(/"/g, '\\"')}"`)
            .join(', ');
          args.push('-c', `${key}.env={ ${envPairs} }`);
        }
      }
    }

    // Attach images via native --image flag
    for (const imgPath of imagePaths) {
      args.push('--image', imgPath);
    }

    // '--' separates options from positional prompt
    // (required because --image <FILE>... is variadic and would consume the prompt)
    args.push('--');

    // System prompt as part of the message
    const fullPrompt = [params.systemPrompt, params.prependContext, params.userMessage]
      .filter(Boolean)
      .join('\n\n');
    args.push(fullPrompt);

    return args;
  }

  /** Write media base64 data to temp files for Codex --image flag. */
  private writeMediaTempFiles(mediaRefs: MediaRef[]): { tempDir: string; paths: string[] } {
    // Resolve base64 from memory or disk for each image ref
    const resolved: Array<{ base64: string; mimeType?: string }> = [];
    for (const ref of mediaRefs) {
      if (ref.mediaType !== 'image') continue;
      const base64 = ref.base64Data ?? this.readLocalPath(ref.localPath);
      if (base64) resolved.push({ base64, mimeType: ref.mimeType });
    }
    if (resolved.length === 0) return { tempDir: '', paths: [] };

    const tempDir = join(tmpdir(), `yourbot-codex-img-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const paths: string[] = [];
    for (const [i, { base64, mimeType }] of resolved.entries()) {
      const ext = mimeType?.split('/')[1] ?? 'png';
      const filePath = join(tempDir, `image-${i}.${ext}`);
      writeFileSync(filePath, Buffer.from(base64, 'base64'));
      paths.push(filePath);
    }

    logger.info('Codex 图片临时文件', { tempDir, count: paths.length });
    return { tempDir, paths };
  }

  private readLocalPath(localPath?: string): string | undefined {
    if (!localPath || !existsSync(localPath)) return undefined;
    try {
      return readFileSync(localPath).toString('base64');
    } catch {
      return undefined;
    }
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
