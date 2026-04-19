import type { MediaRef } from '../../shared/messaging/media-attachment.types';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';

/** Agent provider 标识 — 内置 + 可扩展 */
export type AgentProviderId = 'claude' | 'codex' | 'opencode' | 'gateway' | (string & {});

/** 执行模式 */
export type ExecutionMode = 'sync' | 'async' | 'long-horizon';

/** MCP 服务器配置 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** MCP 配置 */
export interface McpConfig {
  mcpServers: McpServerConfig[];
}

/** Agent 执行参数 — Layer 2 统一输入 */
export interface AgentExecuteParams {
  /** System prompt 全文 */
  systemPrompt: string;
  /** 注入在用户消息前的上下文（memory / task-guidance 等） */
  prependContext: string;
  /** 用户原始消息 */
  userMessage: string;
  /** 会话 ID */
  sessionId: string;
  /** Claude CLI session ID（用于会话恢复） */
  claudeSessionId?: string;
  /** 工作目录 */
  workspacePath?: string;
  /** MCP 工具配置 */
  mcpConfig?: McpConfig;
  /** 允许使用的工具白名单 */
  toolWhitelist?: string[];
  /** 取消信号 */
  signal?: AbortSignal;
  /** 流式回调 */
  streamCallback?: (event: StreamEvent) => Promise<void>;
  /** 最大交互轮数 */
  maxTurns?: number;
  /** 执行模式 */
  executionMode: ExecutionMode;
  /** 分类结果（透传给 Agent 实现） */
  classifyResult?: Record<string, unknown>;
  /** 当前消息附带的媒体引用（图片等） */
  mediaRefs?: MediaRef[];
}

/** Agent 执行结果 */
export interface AgentResult {
  content: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
  toolsUsed?: string[];
  claudeSessionId?: string;
  turnsUsed?: number;
  finishedNaturally: boolean;
  handledBy: AgentProviderId;
}

/**
 * 统一 Agent 桥接接口 — Layer 2 的核心抽象。
 *
 * 每个 provider（Claude Code / Codex / 未来的其他 Agent）
 * 实现此接口即可接入 Agent Layer。
 */
export interface AgentBridge {
  /** 执行一次完整的 agent 会话 */
  execute(params: AgentExecuteParams): Promise<AgentResult>;
  /** 向活跃会话追加消息（long-horizon 场景） */
  appendMessage?(sessionKey: string, content: string): Promise<void>;
  /** 取消活跃会话 */
  abort?(sessionKey: string): Promise<void>;
}
