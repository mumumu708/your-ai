import { describe, expect, mock, test } from 'bun:test';
import { retrieveMemories } from './memory-retriever-v2';
import type { OpenVikingClient } from './openviking/openviking-client';

function createMockOV(): OpenVikingClient {
  return {
    find: mock(async () => []),
    overview: mock(async (uri: string) => `overview of ${uri}`),
    abstract: mock(async (uri: string) => `abstract of ${uri}`),
    read: mock(async (uri: string) => `content of ${uri}`),
  } as unknown as OpenVikingClient;
}

/** Helper: mock find() to return items from first call (memories), empty from second (resources) */
function mockFindOnce(ov: OpenVikingClient, items: unknown[]) {
  let callCount = 0;
  (ov.find as ReturnType<typeof mock>).mockImplementation(async () => {
    callCount++;
    return callCount === 1 ? items : [];
  });
}

describe('retrieveMemories', () => {
  test('returns empty when no results found', async () => {
    const ov = createMockOV();
    const result = await retrieveMemories(ov, { query: 'test' });
    expect(result).toEqual([]);
  });

  test('loads L1 context when budget > 2000', async () => {
    const ov = createMockOV();
    mockFindOnce(ov, [
      {
        uri: 'viking://mem/dir',
        context_type: 'memory',
        abstract: 'a',
        score: 0.9,
        match_reason: 'r',
      },
    ]);

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 4000 });
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe('L1');
    expect(ov.read).toHaveBeenCalled();
  });

  test('loads L0 context when budget between 100 and 2000', async () => {
    const ov = createMockOV();
    mockFindOnce(ov, [
      {
        uri: 'viking://mem/dir',
        context_type: 'memory',
        abstract: 'a',
        score: 0.9,
        match_reason: 'r',
      },
    ]);

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 500 });
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe('L0');
    expect(ov.abstract).toHaveBeenCalled();
  });

  test('skips item when budget is too low (<=100)', async () => {
    const ov = createMockOV();
    mockFindOnce(ov, [
      {
        uri: 'viking://mem/dir',
        context_type: 'memory',
        abstract: 'a',
        score: 0.9,
        match_reason: 'r',
      },
    ]);

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 50 });
    expect(result).toHaveLength(0);
  });

  test('L1 always uses read() for full content', async () => {
    const ov = createMockOV();
    mockFindOnce(ov, [
      {
        uri: 'viking://mem/file.md',
        context_type: 'memory',
        abstract: 'a',
        score: 0.9,
        match_reason: 'r',
      },
    ]);

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 4000 });
    expect(result).toHaveLength(1);
    expect(ov.read).toHaveBeenCalledWith('viking://mem/file.md');
  });

  test('uses read() for file URIs at L0 level', async () => {
    const ov = createMockOV();
    mockFindOnce(ov, [
      {
        uri: 'viking://mem/file.txt',
        context_type: 'memory',
        abstract: 'a',
        score: 0.9,
        match_reason: 'r',
      },
    ]);

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 500 });
    expect(result).toHaveLength(1);
    expect(ov.read).toHaveBeenCalledWith('viking://mem/file.txt');
    expect(ov.abstract).not.toHaveBeenCalled();
  });

  test('handles errors during context loading gracefully', async () => {
    const ov = createMockOV();
    mockFindOnce(ov, [
      {
        uri: 'viking://mem/fail',
        context_type: 'memory',
        abstract: 'a',
        score: 0.9,
        match_reason: 'r',
      },
      {
        uri: 'viking://mem/ok',
        context_type: 'memory',
        abstract: 'b',
        score: 0.8,
        match_reason: 'r',
      },
    ]);
    // Both read() calls fail for 'fail' URI → skipped; 'ok' URI succeeds
    (ov.read as ReturnType<typeof mock>).mockImplementation(async (uri: string) => {
      if (uri.includes('fail')) throw new Error('load failed');
      return `content of ${uri}`;
    });

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 6000 });
    expect(result).toHaveLength(1);
    expect(result[0].uri).toBe('viking://mem/ok');
  });

  test('merges memory and resource results sorted by score', async () => {
    const ov = createMockOV();
    let callCount = 0;
    (ov.find as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          {
            uri: 'viking://mem',
            context_type: 'memory',
            abstract: 'a',
            score: 0.5,
            match_reason: 'r',
          },
        ];
      }
      return [
        {
          uri: 'viking://res',
          context_type: 'resource',
          abstract: 'b',
          score: 0.9,
          match_reason: 'r',
        },
      ];
    });

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 6000 });
    expect(result).toHaveLength(2);
    expect(result[0].uri).toBe('viking://res');
    expect(result[1].uri).toBe('viking://mem');
  });

  test('stops loading when budget is exhausted', async () => {
    const ov = createMockOV();
    const items = Array.from({ length: 10 }, (_, i) => ({
      uri: `viking://mem/item${i}`,
      context_type: 'memory' as const,
      abstract: `item ${i}`,
      score: 0.9 - i * 0.01,
      match_reason: 'r',
    }));
    mockFindOnce(ov, items);

    const result = await retrieveMemories(ov, { query: 'test', tokenBudget: 2500 });
    expect(result.length).toBeLessThan(10);
  });

  test('uses default options', async () => {
    const ov = createMockOV();
    await retrieveMemories(ov, { query: 'test' });
    expect(ov.find).toHaveBeenCalledTimes(2);
  });
});
