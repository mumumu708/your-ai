/**
 * Shared interfaces for memory-layer types.
 *
 * These interfaces allow `lessons/` to reference kernel memory types
 * without creating architecture violations.
 * The concrete implementations in `kernel/memory/` satisfy these
 * interfaces via TypeScript structural typing.
 */

export interface AIEOSConfig {
  soul: string;
  identity: string;
  user: string;
  agents: string;
}

/** Interface for the global config loader */
export interface IConfigLoader {
  loadAll(): Promise<AIEOSConfig>;
  invalidateCache(): void;
  getLessonsLearned(): Promise<string>;
  updateUserProfile(userId: string, content: string): Promise<void>;
}

/** Interface for per-user config loader */
export interface IUserConfigLoader {
  loadAll(): Promise<AIEOSConfig>;
  writeConfig(filename: string, content: string): Promise<void>;
  invalidateCache(): void;
}

/** Interface for OpenViking client (write method used by lessons) */
export interface IOpenVikingClient {
  write(uri: string, content: string): Promise<void>;
}
