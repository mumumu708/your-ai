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
  harnessGroupChatId?: string;
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
