import type { ConversationMessage } from '../agents/agent-instance.types';
import type { UnifiedClassifyResult } from '../classifier/classifier-types';
import type { BotMessage } from '../messaging/bot-message.types';

export type TaskType = 'chat' | 'scheduled' | 'automation' | 'system' | 'harness';

export interface TaskMetadata {
  userId: string;
  channel: string;
  conversationId: string;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  userId: string;
  channel: string;
  conversationId: string;
  status: 'active' | 'expired' | 'closed';
  createdAt: number;
  lastActiveAt: number;
  agentConfig: {
    maxContextTokens: number;
  };
  messages: ConversationMessage[];
  workspacePath?: string;
  hasRecentToolUse?: boolean;
  // Opaque kernel types — kernel code casts to concrete types when needed
  // biome-ignore lint/suspicious/noExplicitAny: opaque kernel type stored on session
  workingMemory?: any;
  claudeSessionId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: opaque kernel type stored on session
  userConfigLoader?: any;
  // Harness worktree binding — persists across messages in the same session
  harnessWorktreeSlotId?: string;
  harnessWorktreePath?: string;
  harnessBranch?: string;
  harnessGroupChatId?: string;
  // DD-018: Session-level frozen prompt + per-turn context state
  frozenSystemPrompt?: {
    content: string;
    totalTokens: number;
    builtAt: number;
    sections: Record<string, string>;
  };
  prependContext?: string;
  invokedSkills?: Set<string>;
  activeMcpServers?: Set<string>;
  previousMcpServers?: Set<string>;
  postCompaction?: boolean;
}

export interface Task {
  id: string;
  traceId: string;
  type: TaskType;
  message: BotMessage;
  session: Session;
  priority: number;
  createdAt: number;
  signal?: AbortSignal;
  metadata: TaskMetadata;
  classifyResult?: UnifiedClassifyResult;
}

// ── Session persistence types ──

export interface SessionRecord {
  id: string;
  userId: string;
  channel: string;
  conversationId?: string;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  messageCount: number;
  summary?: string;
  reflectionProcessed: boolean;
}

export interface MessageRecord {
  id?: number;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  tokenEstimate?: number;
}

export interface SearchResult {
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  channel: string;
  sessionSummary?: string;
  highlight: string;
}

// ── Task persistence types (DD-017) ──

export type ExecutionMode = 'sync' | 'async' | 'long-horizon';

export interface TaskRecord {
  id: string;
  userId: string;
  sessionId: string;
  type: string;
  executionMode: ExecutionMode;
  source: 'user' | 'system' | 'scheduler';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  description?: string;
  inboundMessageId?: string;
  claudeSessionId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  resultSummary?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskPayload {
  type: string;
  message: BotMessage;
  executionMode?: ExecutionMode;
  source: 'user' | 'system' | 'scheduler';
  metadata?: Record<string, unknown>;
}
