export type TaskComplexity = 'simple' | 'complex';

export interface ClassifyResult {
  complexity: TaskComplexity;
  reason: string;
  confidence: number; // 0-1
  classifiedBy: 'rule' | 'llm';
  costUsd: number;
}

export interface ClassifyContext {
  hasRecentToolUse?: boolean;
  conversationLength?: number;
  userId?: string;
}

export interface ClassifierStats {
  total: number;
  ruleClassified: number;
  llmClassified: number;
  simpleCount: number;
  complexCount: number;
}
