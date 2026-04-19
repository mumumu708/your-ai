import { describe, expect, mock, test } from 'bun:test';
import { ContextManager } from './context-manager';
import type { OpenVikingClient } from './openviking/openviking-client';

function createMockOV(): OpenVikingClient {
  return {
    commit: mock(async () => ({ memories_extracted: 2 })),
    find: mock(async () => [
      { uri: 'viking://m1', context_type: 'memory', abstract: 'a', score: 0.9, match_reason: 'r' },
      { uri: 'viking://m2', context_type: 'memory', abstract: 'b', score: 0.8, match_reason: 'r' },
    ]),
    read: mock(async (uri: string) => `summary of ${uri}`),
  } as unknown as OpenVikingClient;
}

describe('ContextManager', () => {
  test('returns null when below threshold', async () => {
    const ov = createMockOV();
    const cm = new ContextManager(ov, 100_000, 0.8);
    const result = await cm.checkAndFlush('s1', 50_000);
    expect(result).toBeNull();
    expect(ov.commit).not.toHaveBeenCalled();
  });

  test('triggers flush when at threshold', async () => {
    const ov = createMockOV();
    const cm = new ContextManager(ov, 100_000, 0.8);
    const result = await cm.checkAndFlush('s1', 80_000);
    expect(result).not.toBeNull();
    expect(ov.commit).toHaveBeenCalledWith('s1');
  });

  test('triggers flush when above threshold', async () => {
    const ov = createMockOV();
    const cm = new ContextManager(ov, 100_000, 0.8);
    const result = await cm.checkAndFlush('s1', 90_000);
    expect(result).not.toBeNull();
    expect(result).toContain('关键记忆');
    expect(result).toContain('summary of viking://m1');
    expect(result).toContain('summary of viking://m2');
  });

  test('uses default maxTokens and threshold', async () => {
    const ov = createMockOV();
    const cm = new ContextManager(ov);
    // Default: 128_000 * 0.8 = 102_400
    const result = await cm.checkAndFlush('s1', 110_000);
    expect(result).not.toBeNull();
  });

  test('returns anchor with no memories when find returns empty', async () => {
    const ov = createMockOV();
    (ov.find as ReturnType<typeof mock>).mockResolvedValue([]);
    const cm = new ContextManager(ov, 100, 0.5);
    const result = await cm.checkAndFlush('s1', 80);
    expect(result).not.toBeNull();
    expect(result).toContain('关键记忆');
  });
});
