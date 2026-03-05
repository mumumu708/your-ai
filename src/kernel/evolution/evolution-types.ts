import type { MemoryCategory, MemorySearchResult } from '../memory/memory-types';

// --- Knowledge Source ---

export type KnowledgeSource = 'identity' | 'soul' | 'user' | 'memory' | 'session' | 'workspace';

// --- Rule Classification ---

export type RuleClassification = 'safety' | 'compliance' | 'style' | 'preference' | 'general';

// --- Knowledge Fragment ---

export interface KnowledgeFragment {
  source: KnowledgeSource;
  content: string;
  priority: number;
  category?: MemoryCategory;
  tokens: number;
  ruleClass?: RuleClassification;
}

// --- Resolved Context ---

export interface ResolvedContext {
  systemPrompt: string;
  fragments: KnowledgeFragment[];
  totalTokens: number;
  conflictsResolved: ConflictResolution[];
  retrievedMemories: MemorySearchResult[];
}

// --- Conflict Resolution ---

export interface ConflictResolution {
  winner: KnowledgeFragment;
  loser: KnowledgeFragment;
  reason: string;
}

// --- Knowledge Router Config ---

export interface KnowledgeRouterConfig {
  maxContextTokens: number;
  identityBudgetRatio: number;
  memoryBudgetRatio: number;
  sessionBudgetRatio: number;
  maxMemoryResults: number;
  minRelevanceScore: number;
}

export const DEFAULT_ROUTER_CONFIG: KnowledgeRouterConfig = {
  maxContextTokens: 4000,
  identityBudgetRatio: 0.3,
  memoryBudgetRatio: 0.5,
  sessionBudgetRatio: 0.2,
  maxMemoryResults: 5,
  minRelevanceScore: 0.1,
};

// --- Workspace Info ---

export interface WorkspaceInfo {
  availableSkills: string[];
  recentToolsUsed: string[];
}

// --- Correction Detection ---

export interface DetectedCorrection {
  originalStatement: string;
  correction: string;
  ruleCandidate: string;
  confidence: number;
  category: 'preference' | 'fact' | 'instruction';
}

// --- Memory Lifecycle ---

export type LifecycleAction =
  | { type: 'archive'; reason: string }
  | { type: 'merge'; targetId: string; reason: string }
  | { type: 'delete'; reason: string }
  | { type: 'keep' };

export interface LifecycleDecision {
  entryId: string;
  action: LifecycleAction;
}

export interface MemoryLifecycleConfig {
  staleThresholdMs: number;
  maxEntriesPerUser: number;
  mergeOverlapThreshold: number;
  runIntervalCron: string;
}

export const DEFAULT_LIFECYCLE_CONFIG: MemoryLifecycleConfig = {
  staleThresholdMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxEntriesPerUser: 500,
  mergeOverlapThreshold: 0.6,
  runIntervalCron: '0 3 * * *',
};
