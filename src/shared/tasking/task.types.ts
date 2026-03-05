import type { ConversationMessage } from '../agents/agent-instance.types';
import type { BotMessage } from '../messaging/bot-message.types';
import type { WorkingMemory } from '../../kernel/memory/working-memory';
import type { UserConfigLoader } from '../../kernel/memory/user-config-loader';

export type TaskType = 'chat' | 'scheduled' | 'automation' | 'system';

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
  workingMemory?: WorkingMemory;
  claudeSessionId?: string;
  userConfigLoader?: UserConfigLoader;
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
}
