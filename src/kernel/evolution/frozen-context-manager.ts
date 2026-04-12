export interface FrozenContext {
  soul: string;
  identity: string;
  user: string;
  agents: string;
  memorySnapshot: string;
  skillIndex: string;
  frozenAt: number;
}

export class FrozenContextManager {
  // biome-ignore lint/complexity/noUselessConstructor: explicit for bun coverage
  constructor() {}

  /**
   * Create a frozen snapshot of all context for a session.
   * Once created, this snapshot is immutable for the session's lifetime.
   */
  freeze(params: {
    soul: string;
    identity: string;
    user: string;
    agents: string;
    memorySnapshot: string;
    skillIndex: string;
  }): FrozenContext {
    return {
      ...params,
      frozenAt: Date.now(),
    };
  }

  /**
   * Check if a frozen context needs rebuild (e.g., after compaction).
   */
  needsRebuild(frozen: FrozenContext, compactionTimestamp?: number): boolean {
    if (!compactionTimestamp) return false;
    return compactionTimestamp > frozen.frozenAt;
  }
}
