import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { Logger } from '../../shared/logging/logger';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';

export interface AgentBridgeParams {
  sessionId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onStream?: (event: StreamEvent) => void;
  userId?: string;
  /** Working directory for the claude subprocess */
  cwd?: string;
  /** Claude CLI session ID for resuming conversations */
  claudeSessionId?: string;
}

export interface AgentBridgeResult {
  content: string;
  toolsUsed: string[];
  turns: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  /** Claude CLI session ID returned from the process */
  claudeSessionId?: string;
}

/** Parsed stream-json event from claude CLI */
interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{ type: string; text?: string; thinking?: string; name?: string }>;
  };
  result?: string;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      costUSD?: number;
    }
  >;
}

export interface ClaudeAgentBridgeConfig {
  /** Path to claude CLI binary. Default: 'claude' */
  claudePath?: string;
  /** Default model. Default: 'sonnet' */
  defaultModel?: string;
  /** Max concurrent sessions. Default: 20 */
  maxConcurrentSessions?: number;
}

const DEFAULT_MODEL = 'sonnet';
const MAX_CONCURRENT_SESSIONS = 20;
const MAX_PROMPT_TOKENS = 80_000;
const CHARS_PER_TOKEN = 4;

/**
 * Bridge to Claude Code CLI.
 * Spawns `claude -p` subprocess with stream-json output for each request.
 */
export class ClaudeAgentBridge {
  private readonly logger = new Logger('ClaudeAgentBridge');
  private readonly claudePath: string;
  private readonly defaultModel: string;
  private readonly maxConcurrent: number;
  private activeSessions = 0;

  constructor(config?: ClaudeAgentBridgeConfig) {
    this.claudePath = config?.claudePath ?? 'claude';
    this.defaultModel = config?.defaultModel ?? DEFAULT_MODEL;
    this.maxConcurrent = config?.maxConcurrentSessions ?? MAX_CONCURRENT_SESSIONS;
  }

  async execute(params: AgentBridgeParams): Promise<AgentBridgeResult> {
    if (this.activeSessions >= this.maxConcurrent) {
      throw new YourBotError(ERROR_CODES.AGENT_BUSY, '并发会话数已达上限', {
        current: this.activeSessions,
        max: this.maxConcurrent,
      });
    }

    this.activeSessions++;
    const model = params.model ?? this.defaultModel;

    this.logger.info('Claude Code 执行', {
      sessionId: params.sessionId,
      model,
      messageCount: params.messages.length,
    });

    try {
      // Determine resume vs fresh mode
      const isResume = !!params.claudeSessionId;

      // Build the prompt
      const prompt = isResume
        ? (params.messages[params.messages.length - 1]?.content ?? '')
        : this.buildPrompt(params.messages);

      // Build args
      const args: string[] = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
      ];

      if (isResume) {
        // Resume existing Claude session — only send the latest message
        args.push('--resume', params.claudeSessionId!);
      }

      if (params.systemPrompt) {
        args.push('--system-prompt', params.systemPrompt);
      }

      // Build clean env (strip CLAUDECODE to avoid nesting detection)
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== 'CLAUDECODE' && v !== undefined) {
          cleanEnv[k] = v;
        }
      }

      if (isResume) {
        this.logger.info('Claude Code 会话续接', {
          sessionId: params.sessionId,
          claudeSessionId: params.claudeSessionId,
        });
      }

      const proc = Bun.spawn([this.claudePath, ...args], {
        env: cleanEnv,
        cwd: params.cwd ?? process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Handle abort signal
      if (params.signal) {
        params.signal.addEventListener('abort', () => {
          proc.kill();
        });
      }

      let result = await this.processStream(proc, params);

      const exitCode = await proc.exited;

      // Resume failure fallback: retry with full prompt (no --resume)
      if (exitCode !== 0 && isResume) {
        this.logger.warn('Claude 会话续接失败，回退到全量 prompt 模式', {
          sessionId: params.sessionId,
          claudeSessionId: params.claudeSessionId,
          exitCode,
        });
        // Retry without resume
        result = await this.executeWithoutResume(params, model, cleanEnv);
      } else if (exitCode !== 0 && !result.content) {
        const stderrText = await new Response(proc.stderr).text();
        throw new YourBotError(ERROR_CODES.LLM_API_ERROR, `Claude CLI 退出码 ${exitCode}`, {
          stderr: stderrText.slice(0, 500),
        });
      }

      this.logger.info('Claude Code 完成', {
        sessionId: params.sessionId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        turns: result.turns,
        claudeSessionId: result.claudeSessionId,
      });

      return result;
    } catch (error) {
      if (error instanceof YourBotError) throw error;

      this.logger.error('Claude Code 执行失败', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new YourBotError(ERROR_CODES.LLM_API_ERROR, 'Claude Code 调用失败', {
        sessionId: params.sessionId,
        originalError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeSessions--;
    }
  }

  getActiveSessions(): number {
    return this.activeSessions;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /**
   * Fallback execution without --resume (full prompt mode).
   */
  private async executeWithoutResume(
    params: AgentBridgeParams,
    model: string,
    cleanEnv: Record<string, string>,
  ): Promise<AgentBridgeResult> {
    const prompt = this.buildPrompt(params.messages);
    const args: string[] = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
    ];
    if (params.systemPrompt) {
      args.push('--system-prompt', params.systemPrompt);
    }

    const proc = Bun.spawn([this.claudePath, ...args], {
      env: cleanEnv,
      cwd: params.cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (params.signal) {
      params.signal.addEventListener('abort', () => {
        proc.kill();
      });
    }

    const result = await this.processStream(proc, params);
    const exitCode = await proc.exited;
    if (exitCode !== 0 && !result.content) {
      const stderrText = await new Response(proc.stderr).text();
      throw new YourBotError(ERROR_CODES.LLM_API_ERROR, `Claude CLI 退出码 ${exitCode}`, {
        stderr: stderrText.slice(0, 500),
      });
    }
    return result;
  }

  private async processStream(
    proc: ReturnType<typeof Bun.spawn>,
    params: AgentBridgeParams,
  ): Promise<AgentBridgeResult> {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === 'number') {
      throw new Error('Failed to capture stdout from Claude CLI process');
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let turns = 0;
    const toolsUsedSet = new Set<string>();
    let claudeSessionId: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: ClaudeStreamEvent;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue; // Skip non-JSON lines
          }

          this.handleStreamEvent(event, params, {
            appendContent: (text: string) => {
              content += text;
            },
            setUsage: (inp: number, out: number, cost: number, t: number) => {
              inputTokens = inp;
              outputTokens = out;
              costUsd = cost;
              turns = t;
            },
            addToolUsed: (name: string) => {
              toolsUsedSet.add(name);
            },
            setClaudeSessionId: (id: string) => {
              claudeSessionId = id;
            },
          });
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (params.onStream) {
      params.onStream({ type: 'done' });
    }

    return {
      content,
      toolsUsed: Array.from(toolsUsedSet),
      turns,
      usage: { inputTokens, outputTokens, costUsd },
      claudeSessionId,
    };
  }

  private handleStreamEvent(
    event: ClaudeStreamEvent,
    params: AgentBridgeParams,
    ctx: {
      appendContent: (text: string) => void;
      setUsage: (inp: number, out: number, cost: number, turns: number) => void;
      addToolUsed: (name: string) => void;
      setClaudeSessionId: (id: string) => void;
    },
  ): void {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          ctx.appendContent(block.text);
          if (params.onStream) {
            params.onStream({ type: 'text_delta', text: block.text });
          }
        }
        // Capture tool_use blocks
        if (block.type === 'tool_use' && block.name) {
          ctx.addToolUsed(block.name);
        }
      }
    }

    if (event.type === 'result') {
      // Final result event contains aggregated usage
      const firstModelUsage = event.modelUsage ? Object.values(event.modelUsage)[0] : undefined;

      ctx.setUsage(
        firstModelUsage?.inputTokens ?? event.usage?.input_tokens ?? 0,
        firstModelUsage?.outputTokens ?? event.usage?.output_tokens ?? 0,
        event.total_cost_usd ?? firstModelUsage?.costUSD ?? 0,
        event.subtype === 'success' ? 1 : 0,
      );

      // Capture session ID from result event
      if (event.session_id) {
        ctx.setClaudeSessionId(event.session_id);
      }
    }
  }

  /**
   * Build a single prompt string from conversation messages.
   * Applies token budget: walks from newest to oldest, stops when exceeding MAX_PROMPT_TOKENS.
   * Always preserves the last user message.
   */
  private buildPrompt(messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
    if (messages.length === 1) {
      return messages[0]!.content;
    }

    // Walk from newest to oldest, accumulating token budget
    const maxChars = MAX_PROMPT_TOKENS * CHARS_PER_TOKEN;
    let totalChars = 0;
    const selected: Array<{ role: string; content: string }> = [];
    let omittedCount = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      const formatted = msg.role === 'user' ? `用户: ${msg.content}` : `助手: ${msg.content}`;
      const msgChars = formatted.length + 2; // +2 for \n\n separator

      if (totalChars + msgChars > maxChars && selected.length > 0) {
        // Budget exceeded — count remaining as omitted
        omittedCount = i + 1;
        break;
      }

      totalChars += msgChars;
      selected.unshift(msg);
    }

    const parts: string[] = [];

    if (omittedCount > 0) {
      parts.push(`[前${omittedCount}条消息已省略]`);
    }

    for (const msg of selected) {
      if (msg.role === 'user') {
        parts.push(`用户: ${msg.content}`);
      } else {
        parts.push(`助手: ${msg.content}`);
      }
    }

    return parts.join('\n\n');
  }
}
