/**
 * Shared mock OV dependencies for integration/E2E tests.
 * Prevents CentralController from making real HTTP calls to OpenViking.
 */
import type { CentralControllerDeps } from '../kernel/central-controller';

export function createMockOVDeps(): Partial<CentralControllerDeps> {
  return {
    knowledgeRouter: {
      buildContext: async () => ({
        systemPrompt: '--- Agent Identity ---\nTest Agent\n--- Agent Soul ---\nBe helpful',
        fragments: [],
        totalTokens: 20,
        conflictsResolved: [],
        retrievedMemories: [],
      }),
    } as any,
    postResponseAnalyzer: {
      analyzeExchange: async () => null,
    } as any,
    ovClient: {
      addMessage: async () => {},
      commit: async () => ({ memories_extracted: 0 }),
    } as any,
    contextManager: {
      checkAndFlush: async () => null,
    } as any,
    configLoader: {
      loadAll: async () => ({
        soul: 'Be helpful',
        identity: 'Test Agent',
        user: '',
        agents: '',
      }),
      invalidateCache: () => {},
    } as any,
    lessonsUpdater: {
      addLesson: async () => true,
    } as any,
    evolutionScheduler: {
      schedulePostCommit: () => {},
    } as any,
    entityManager: {} as any,
  };
}
