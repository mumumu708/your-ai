export interface ToolConfig {
  name: string;
  description: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface AgentConstraints {
  maxConcurrentSessions: number;
  maxDailyTokens: number;
  allowedTools: string[];
  blockedCommands: string[];
  maxExecutionTimeMs: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  model: 'claude-sonnet-4-20250514' | 'claude-3-5-haiku-20241022';
  maxTokens: number;
  maxContextTokens: number;
  temperature: number;
  systemPromptPath: string;
  tools: ToolConfig[];
  constraints: AgentConstraints;
}
