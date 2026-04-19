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
export { KnowledgeRouter, type KnowledgeRouterDeps } from './knowledge-router';
export { ErrorToRulePipeline } from './learning/error-to-rule-pipeline';
export {
  PostResponseAnalyzer,
  type PostResponseAnalyzerDeps,
} from './learning/post-response-analyzer';

// --- New: Evolution engine modules ---
export { EvolutionScheduler } from './evolution-scheduler';
export { reflect } from './reflect';
export { linkMemory } from './link';
export { evolveMemory } from './evolve';

// --- DD-012: Memory & Reflection upgrade modules ---
export {
  ReflectionTrigger,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
} from './reflection-trigger';
export {
  ReflectionPromptBuilder,
  REFLECTION_SYSTEM_PROMPT,
  type SessionSummary,
} from './reflection-prompt-builder';
export { routeAnalysis, type AnalysisItem, type RoutedAnalysis } from './analysis-router';
export { FrozenContextManager, type FrozenContext } from './frozen-context-manager';

// --- DD-022: Learning pipeline (absorbed from src/lessons/) ---
export { detectErrorSignal, type ErrorSignal } from './learning/error-detector';
export { extractLesson, type ExtractedLesson, type LlmCallFn } from './learning/lesson-extractor';
export { LessonsLearnedUpdater } from './learning/lessons-updater';
export { handleManualCommand, type ManualCommandResult } from './learning/manual-management';

// --- DD-022: Digest pipeline ---
export {
  shouldTriggerDigest,
  clusterItems,
  clusterItemsWithOV,
  distillClusters,
  scanUndigested,
  writeInsights,
  DIGEST_SYSTEM_PROMPT,
  buildDigestPrompt,
  type DigestState,
  type DigestCluster,
  type DigestInsight,
  type DigestableItem,
  type LlmDistillFn,
} from './digest';
