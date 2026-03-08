import type { UnifiedClassifyResult } from '../classifier/classifier-types';
import type { StreamEvent } from '../messaging/stream-event.types';
import type { AgentConfig } from './agent-config.types';

export type AgentLifecycleState =
  | 'initializing'
  | 'ready'
  | 'processing'
  | 'tool_executing'
  | 'streaming'
  | 'idle'
  | 'suspended'
  | 'terminated'
  | 'classifying'
  | 'agent_sdk_processing'
  | 'light_llm_processing'
  | 'completing';

export interface AgentInstance {
  id: string;
  config: AgentConfig;
  state: AgentLifecycleState;
  userId: string;
  channelId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ConversationContext {
  sessionId: string;
  messages: ConversationMessage[];
  systemPrompt?: string;
  workspacePath?: string;
  claudeSessionId?: string;
}

export interface AgentExecuteParams {
  agentId: string;
  context: ConversationContext;
  signal?: AbortSignal;
  streamCallback?: (event: StreamEvent) => void;
  /** Force complex (Claude) path, bypassing complexity classification. Used for harness tasks. */
  forceComplex?: boolean;
  /** Pre-computed classification result from CentralController. */
  classifyResult?: UnifiedClassifyResult;
}

export interface AgentResult {
  content: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  toolsUsed?: string[];
  claudeSessionId?: string;
}
