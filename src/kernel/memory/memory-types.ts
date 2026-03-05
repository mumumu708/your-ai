// --- Memory Layer Definitions ---

export type MemoryLayer = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type MemoryCategory = 'preference' | 'fact' | 'context' | 'instruction' | 'task' | 'insight';

export type MemoryImportance = 'low' | 'medium' | 'high' | 'critical';

export type RuleClassification = 'safety' | 'compliance' | 'style' | 'preference' | 'general';

// --- L1: Working Memory ---

export interface WorkingMemoryConfig {
  maxTokens: number;
  compressThreshold?: number; // 0-1, default 0.8
}

export interface ContextSummary {
  content: string;
  messageCount: number;
  createdAt: number;
}

// --- L2: Session Memory ---

export interface SessionSummary {
  sessionId: string;
  userId: string;
  summary: string;
  keywords: string[];
  actionItems: string[];
  preferences: string[];
  messageCount: number;
  startedAt: number;
  endedAt: number;
}

// --- L3/L4: Persistent Memory ---

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  importance: MemoryImportance;
  layer: MemoryLayer;
  userId: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  source?: string; // e.g. 'session_extract', 'daily_aggregate', 'user_explicit'
  metadata?: Record<string, unknown>;
}

// --- L5: AIEOS Identity ---

export type AieosFileType = 'IDENTITY' | 'SOUL' | 'USER' | 'AGENTS';

export interface AieosFiles {
  IDENTITY: string;
  SOUL: string;
  USER: string;
  AGENTS: string;
}

// --- Search ---

export interface MemorySearchOptions {
  query: string;
  userId: string;
  category?: MemoryCategory;
  layer?: MemoryLayer;
  topK?: number;
  minScore?: number;
  timeDecayFactor?: number; // 0-1, higher = more decay
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedTerms: string[];
}

// --- BM25 Parameters ---

export interface BM25Config {
  k1?: number; // Term frequency saturation, default 1.2
  b?: number; // Length normalization, default 0.75
}

// --- Daily Digest ---

export interface DailyDigest {
  date: string; // YYYY-MM-DD
  userId: string;
  sessions: SessionSummary[];
  mergedSummary: string;
  newPreferences: string[];
  activeTopics: string[];
  createdAt: number;
}
