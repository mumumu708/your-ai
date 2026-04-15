/**
 * Shared mock OV dependencies for integration/E2E tests.
 * Prevents CentralController from making real HTTP calls to OpenViking.
 */
import type { CentralControllerDeps } from '../kernel/central-controller';
import type { EvolutionScheduler } from '../kernel/evolution/evolution-scheduler';
import type { KnowledgeRouter } from '../kernel/evolution/knowledge-router';
import type { LessonsLearnedUpdater } from '../kernel/evolution/learning/lessons-updater';
import type { PostResponseAnalyzer } from '../kernel/evolution/learning/post-response-analyzer';
import type { ContextManager } from '../kernel/memory/context-manager';
import type { EntityManager } from '../kernel/memory/graph/entity-manager';
import type { OpenVikingClient } from '../kernel/memory/openviking/openviking-client';
import type { ConfigLoader } from '../kernel/prompt/config-loader';

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
    } as unknown as KnowledgeRouter,
    postResponseAnalyzer: {
      analyzeExchange: async () => null,
    } as unknown as PostResponseAnalyzer,
    ovClient: {
      addMessage: async () => {},
      commit: async () => ({ memories_extracted: 0 }),
    } as unknown as OpenVikingClient,
    contextManager: {
      checkAndFlush: async () => null,
    } as unknown as ContextManager,
    configLoader: {
      loadAll: async () => ({
        soul: 'Be helpful',
        identity: 'Test Agent',
        user: '',
        agents: '',
      }),
      invalidateCache: () => {},
    } as unknown as ConfigLoader,
    lessonsUpdater: {
      addLesson: async () => true,
    } as unknown as LessonsLearnedUpdater,
    evolutionScheduler: {
      schedulePostCommit: () => {},
    } as unknown as EvolutionScheduler,
    entityManager: {} as unknown as EntityManager,
  };
}
