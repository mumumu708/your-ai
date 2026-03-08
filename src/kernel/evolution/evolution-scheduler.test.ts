import { describe, expect, mock, test } from 'bun:test';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

// Mock all three evolution operations
import { mock as bunMock } from 'bun:test';

const mockEvolveMemory = mock(async () => {});
const mockLinkMemory = mock(async () => {});
const mockReflect = mock(async () => {});

bunMock.module('./evolve', () => ({
  evolveMemory: mockEvolveMemory,
}));
bunMock.module('./link', () => ({
  linkMemory: mockLinkMemory,
}));
bunMock.module('./reflect', () => ({
  reflect: mockReflect,
}));

// Must import AFTER mock.module
const { EvolutionScheduler } = await import('./evolution-scheduler');

function createMockOV(): OpenVikingClient {
  return {} as unknown as OpenVikingClient;
}

describe('EvolutionScheduler', () => {
  test('schedulePostCommit enqueues link + reflect jobs', async () => {
    const ov = createMockOV();
    const scheduler = new EvolutionScheduler(ov);

    mockLinkMemory.mockClear();
    mockReflect.mockClear();

    scheduler.schedulePostCommit(['viking://mem/1', 'viking://mem/2']);

    // Give async jobs time to execute
    await new Promise((r) => setTimeout(r, 50));

    expect(mockLinkMemory).toHaveBeenCalledTimes(2);
    expect(mockReflect).toHaveBeenCalledTimes(3); // facts, preferences, procedures
  });

  test('scheduleEvolve enqueues an evolve job', async () => {
    const ov = createMockOV();
    const scheduler = new EvolutionScheduler(ov);

    mockEvolveMemory.mockClear();

    scheduler.scheduleEvolve('new content', 'viking://existing');

    await new Promise((r) => setTimeout(r, 50));

    expect(mockEvolveMemory).toHaveBeenCalledWith(ov, 'new content', 'viking://existing');
  });

  test('respects concurrency limit', async () => {
    const ov = createMockOV();
    const scheduler = new EvolutionScheduler(ov);

    let concurrent = 0;
    let maxConcurrent = 0;

    mockLinkMemory.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    });
    mockReflect.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    });

    scheduler.schedulePostCommit(['v://1', 'v://2', 'v://3', 'v://4']);

    await new Promise((r) => setTimeout(r, 300));

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test('retries failed jobs once', async () => {
    const ov = createMockOV();
    const scheduler = new EvolutionScheduler(ov);

    let callCount = 0;
    mockLinkMemory.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('transient error');
    });
    mockReflect.mockImplementation(async () => {});

    scheduler.schedulePostCommit(['v://1']);

    await new Promise((r) => setTimeout(r, 200));

    // First attempt + 1 retry
    expect(callCount).toBe(2);
  });

  test('does not retry more than maxRetries', async () => {
    const ov = createMockOV();
    const scheduler = new EvolutionScheduler(ov);

    let callCount = 0;
    mockLinkMemory.mockImplementation(async () => {
      callCount++;
      throw new Error('persistent error');
    });
    mockReflect.mockImplementation(async () => {});

    scheduler.schedulePostCommit(['v://1']);

    await new Promise((r) => setTimeout(r, 200));

    // First attempt + 1 retry = 2, not more
    expect(callCount).toBe(2);
  });
});
