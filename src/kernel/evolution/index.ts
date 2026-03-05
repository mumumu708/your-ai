export type {
  KnowledgeSource,
  RuleClassification,
  KnowledgeFragment,
  ResolvedContext,
  ConflictResolution,
  KnowledgeRouterConfig,
  DetectedCorrection,
  LifecycleAction,
  LifecycleDecision,
  MemoryLifecycleConfig,
} from './evolution-types';
export { DEFAULT_ROUTER_CONFIG, DEFAULT_LIFECYCLE_CONFIG } from './evolution-types';

export { TokenBudgetAllocator, type BudgetRatios } from './token-budget-allocator';
export { ConflictResolver } from './conflict-resolver';
export { KnowledgeRouter, type KnowledgeRouterDeps } from './knowledge-router';
export { ErrorToRulePipeline } from './error-to-rule-pipeline';
export { PostResponseAnalyzer, type PostResponseAnalyzerDeps } from './post-response-analyzer';

// --- New: Evolution engine modules ---
export { EvolutionScheduler } from './evolution-scheduler';
export { reflect } from './reflect';
export { linkMemory } from './link';
export { evolveMemory } from './evolve';
