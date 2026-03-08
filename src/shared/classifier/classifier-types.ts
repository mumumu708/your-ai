export type TaskComplexity = 'simple' | 'complex';

export interface UnifiedClassifyResult {
  taskType: 'chat' | 'scheduled' | 'automation' | 'system' | 'harness';
  complexity: TaskComplexity;
  reason: string;
  confidence: number; // 0-1
  classifiedBy: 'rule' | 'llm';
  costUsd: number;
}

/** @deprecated Use UnifiedClassifyResult instead */
export type ClassifyResult = UnifiedClassifyResult;

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
