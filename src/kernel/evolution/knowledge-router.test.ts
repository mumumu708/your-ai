import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ConfigLoader } from '../memory/config-loader';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import { ConflictResolver } from './conflict-resolver';
import { KnowledgeRouter } from './knowledge-router';
import { TokenBudgetAllocator } from './token-budget-allocator';

function createMockConfigLoader(overrides?: Partial<Record<string, string>>): ConfigLoader {
  return {
    loadAll: async () => ({
      soul: overrides?.soul ?? '# Agent Soul\nBe helpful and safe.\nNever share secrets.',
      identity: overrides?.identity ?? '# Agent Identity\nYou are YourBot, a helpful assistant.',
      user: overrides?.user ?? '# User Profile\nPrefers TypeScript.\nLikes concise answers.',
      agents: overrides?.agents ?? '# Agent Manual',
    }),
    invalidateCache: () => {},
    getLessonsLearned: async () => '',
    updateUserProfile: async () => {},
  } as unknown as ConfigLoader;
}

function createMockOVClient(): OpenVikingClient {
  return {
    find: async () => [],
    search: async () => [],
    read: async () => '',
    abstract: async () => '',
  } as unknown as OpenVikingClient;
}

describe('KnowledgeRouter', () => {
  let router: KnowledgeRouter;
  let configLoader: ConfigLoader;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    configLoader = createMockConfigLoader();
    const ovClient = createMockOVClient();
    const conflictResolver = new ConflictResolver();
    const allocator = new TokenBudgetAllocator();

    router = new KnowledgeRouter({
      configLoader,
      ovClient,
      conflictResolver,
      tokenBudgetAllocator: allocator,
    });
  });

  test('simple 任务应该仅加载 identity + soul', async () => {
    const result = await router.buildContext('user1', 'Hello', [], 'simple');

    expect(result.systemPrompt).toContain('Agent Identity');
    expect(result.systemPrompt).toContain('Agent Soul');
    expect(result.systemPrompt).not.toContain('User Profile');
    expect(result.retrievedMemories.length).toBe(0);
    expect(result.totalTokens).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  test('complex 任务应该加载全部上下文', async () => {
    const result = await router.buildContext('user1', 'Help me write code', [], 'complex');

    expect(result.systemPrompt).toContain('Agent Identity');
    expect(result.systemPrompt).toContain('Agent Soul');
    expect(result.systemPrompt).toContain('User Profile');
    expect(result.totalTokens).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  test('complex 任务应该检索记忆', async () => {
    const ovClient = {
      find: async () => [
        {
          uri: 'viking://test',
          content: 'User prefers TypeScript for all projects',
          abstract: '',
          score: 0.9,
          match_reason: '',
        },
      ],
      search: async () => [],
      read: async (_uri: string) => 'User prefers TypeScript for all projects',
      abstract: async () => 'TypeScript preference',
    } as unknown as OpenVikingClient;

    const conflictResolver = new ConflictResolver();
    const allocator = new TokenBudgetAllocator();
    const routerWithMemory = new KnowledgeRouter({
      configLoader,
      ovClient,
      conflictResolver,
      tokenBudgetAllocator: allocator,
    });

    const result = await routerWithMemory.buildContext(
      'user1',
      'Help me with TypeScript',
      [],
      'complex',
    );

    expect(result.systemPrompt).toContain('Relevant Memories');
    logSpy.mockRestore();
  });

  test('搜索查询应该包含最近用户消息', async () => {
    // Spy on ov.find to capture the query
    let capturedQuery = '';
    const ovClient = {
      find: async (opts: { query: string }) => {
        capturedQuery = opts.query;
        return [];
      },
      search: async () => [],
    } as unknown as OpenVikingClient;

    const conflictResolver = new ConflictResolver();
    const allocator = new TokenBudgetAllocator();
    const routerWithSpy = new KnowledgeRouter({
      configLoader,
      ovClient,
      conflictResolver,
      tokenBudgetAllocator: allocator,
    });

    await routerWithSpy.buildContext(
      'user1',
      'Current question',
      [
        { role: 'user', content: 'Previous question about React', timestamp: Date.now() - 1000 },
        { role: 'assistant', content: 'React is...', timestamp: Date.now() - 500 },
      ],
      'complex',
    );

    expect(capturedQuery).toContain('Current question');
    expect(capturedQuery).toContain('Previous question about React');
    logSpy.mockRestore();
  });

  test('空记忆应该优雅降级', async () => {
    const result = await router.buildContext('user1', 'Hello', [], 'complex');

    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.retrievedMemories.length).toBe(0);
    logSpy.mockRestore();
  });

  test('应该包含会话上下文', async () => {
    const result = await router.buildContext(
      'user1',
      'Follow up',
      [
        { role: 'user', content: 'Initial question', timestamp: Date.now() - 1000 },
        { role: 'assistant', content: 'Initial answer', timestamp: Date.now() - 500 },
      ],
      'complex',
    );

    expect(result.systemPrompt).toContain('Session Context');
    logSpy.mockRestore();
  });
});
