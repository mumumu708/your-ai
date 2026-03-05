/** OpenViking client configuration */
export interface OVConfig {
  baseUrl: string; // default http://localhost:1933
  apiKey?: string; // optional, dev mode doesn't need it
  timeout?: number; // request timeout (ms), default 30000
  retries?: number; // retry count, default 2
}

/** Unified response envelope */
export interface OVResponse<T> {
  status: 'ok' | 'error';
  result?: T;
  error?: { code: string; message: string };
  time: number;
}

/** Search options for find/search */
export interface FindOptions {
  query: string;
  target_uri?: string; // search scope, default viking://
  limit?: number; // result count, default 10
  score_threshold?: number; // minimum score threshold
}

/** Raw find/search API response */
export interface FindResponse {
  memories: FindResult[];
  resources: FindResult[];
  skills: FindResult[];
  total: number;
}

/** Search result entry */
export interface FindResult {
  uri: string;
  context_type: 'resource' | 'memory' | 'skill';
  abstract: string;
  score: number;
  match_reason: string;
}

/** Context match with progressive loading level */
export interface MatchedContext {
  uri: string;
  content: string;
  level: 'L0' | 'L1' | 'L2';
  score: number;
}

/** Session object */
export interface OVSession {
  id: string;
  created_at: string;
  properties: Record<string, unknown>;
  message_count: number;
}

/** File entry in VikingFS */
export interface FileEntry {
  name: string;
  uri: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

/** Relation between resources */
export interface Relation {
  uri: string;
  reason: string;
  created_at: string;
}

/** Memory category in VikingFS */
export type MemoryCategory =
  | 'facts'
  | 'preferences'
  | 'procedures'
  | 'episodic'
  | 'semantic'
  | 'meta';
