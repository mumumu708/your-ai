export type {
  MemoryLayer,
  MemoryCategory,
  MemoryImportance,
  RuleClassification,
  WorkingMemoryConfig,
  ContextSummary,
  SessionSummary,
  MemoryEntry,
  AieosFileType,
  AieosFiles,
  MemorySearchOptions,
  MemorySearchResult,
  BM25Config,
  DailyDigest,
} from './memory-types';

// --- OpenViking-based modules ---
export { OpenVikingClient, OVError } from './openviking';
export type {
  OVConfig,
  OVResponse,
  FindOptions,
  FindResult,
  MatchedContext,
  OVSession,
  FileEntry,
  Relation,
  MemoryCategory as OVMemoryCategory,
} from './openviking';
export { ConfigLoader, type AIEOSConfig } from './config-loader';
export { UserConfigLoader } from './user-config-loader';
export { retrieveMemories, type RetrieveOptions } from './memory-retriever-v2';
export { ContextManager } from './context-manager';
export { EntityManager, type GraphQueryResult } from './graph/entity-manager';

// --- Still used by SessionManager during transition ---
export { WorkingMemory } from './working-memory';
export { SessionMemoryExtractor, type LlmExtractFn } from './session-memory-extractor';
