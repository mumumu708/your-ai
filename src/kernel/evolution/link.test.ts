import { describe, expect, mock, test } from 'bun:test';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import { linkMemory } from './link';

function createMockOV(): OpenVikingClient {
  return {
    read: mock(async () => 'memory content for linking'),
    search: mock(async () => []),
    link: mock(async () => {}),
  } as unknown as OpenVikingClient;
}

describe('linkMemory', () => {
  test('creates links for similar memories with score > 0.75', async () => {
    const ov = createMockOV();
    (ov.search as ReturnType<typeof mock>).mockResolvedValue([
      { uri: 'viking://mem/other', score: 0.85 },
    ]);

    await linkMemory(ov, 'viking://mem/new');
    expect(ov.link).toHaveBeenCalledWith(
      'viking://mem/new',
      ['viking://mem/other'],
      expect.stringContaining('semantic_similarity'),
    );
  });

  test('skips self-referencing results', async () => {
    const ov = createMockOV();
    (ov.search as ReturnType<typeof mock>).mockResolvedValue([
      { uri: 'viking://mem/new', score: 1.0 },
    ]);

    await linkMemory(ov, 'viking://mem/new');
    expect(ov.link).not.toHaveBeenCalled();
  });

  test('skips results with score <= 0.75', async () => {
    const ov = createMockOV();
    (ov.search as ReturnType<typeof mock>).mockResolvedValue([
      { uri: 'viking://mem/other', score: 0.5 },
    ]);

    await linkMemory(ov, 'viking://mem/new');
    expect(ov.link).not.toHaveBeenCalled();
  });

  test('does not log when no links created', async () => {
    const ov = createMockOV();
    await linkMemory(ov, 'viking://mem/new');
    expect(ov.link).not.toHaveBeenCalled();
  });

  test('links multiple similar memories', async () => {
    const ov = createMockOV();
    (ov.search as ReturnType<typeof mock>).mockResolvedValue([
      { uri: 'viking://mem/a', score: 0.9 },
      { uri: 'viking://mem/b', score: 0.8 },
      { uri: 'viking://mem/c', score: 0.5 }, // below threshold
    ]);

    await linkMemory(ov, 'viking://mem/new');
    expect(ov.link).toHaveBeenCalledTimes(2);
  });
});
