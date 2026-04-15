import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ConfigLoader } from './config-loader';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

function createMockOV(): OpenVikingClient {
  return {
    tryRead: mock(async () => null),
    write: mock(async () => {}),
  } as unknown as OpenVikingClient;
}

describe('ConfigLoader', () => {
  let ov: OpenVikingClient;
  let loader: ConfigLoader;
  let bunFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    ov = createMockOV();
    loader = new ConfigLoader(ov);
    // Mock Bun.file to simulate local files
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => false,
          text: async () => '',
        }) as unknown as ReturnType<typeof Bun.file>,
    );
  });

  afterEach(() => {
    bunFileSpy.mockRestore();
  });

  // ─── loadAll ─────────────────────────────────────────
  test('loads all 4 config files and caches', async () => {
    const config = await loader.loadAll();
    expect(config).toHaveProperty('soul');
    expect(config).toHaveProperty('identity');
    expect(config).toHaveProperty('user');
    expect(config).toHaveProperty('agents');
  });

  test('returns cached result within TTL', async () => {
    await loader.loadAll();
    // Second call should use cache — ov.tryRead shouldn't be called again
    (ov.tryRead as ReturnType<typeof mock>).mockClear();
    await loader.loadAll();
    expect(ov.tryRead).not.toHaveBeenCalled();
  });

  test('forceRefresh bypasses cache', async () => {
    await loader.loadAll();
    (ov.tryRead as ReturnType<typeof mock>).mockClear();
    await loader.loadAll(true);
    expect(ov.tryRead).toHaveBeenCalled();
  });

  test('invalidateCache forces re-read', async () => {
    await loader.loadAll();
    loader.invalidateCache();
    (ov.tryRead as ReturnType<typeof mock>).mockClear();
    await loader.loadAll();
    expect(ov.tryRead).toHaveBeenCalled();
  });

  // ─── loadFile ────────────────────────────────────────
  test('reads local file if it exists', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => true,
          text: async () => '# Local Soul',
        }) as unknown as ReturnType<typeof Bun.file>,
    );

    const config = await loader.loadAll(true);
    expect(config.soul).toBe('# Local Soul');
  });

  test('falls back to VikingFS when local file missing', async () => {
    (ov.tryRead as ReturnType<typeof mock>).mockResolvedValue('# Viking Soul');

    const content = await loader.loadFile('SOUL.md');
    expect(content).toBe('# Viking Soul');
  });

  test('returns placeholder when both local and VikingFS miss', async () => {
    const content = await loader.loadFile('SOUL.md');
    expect(content).toContain('not found');
  });

  test('falls back to VikingFS when local file throws', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(() => {
      throw new Error('fs error');
    });

    (ov.tryRead as ReturnType<typeof mock>).mockResolvedValue('# Fallback');
    const content = await loader.loadFile('SOUL.md');
    expect(content).toBe('# Fallback');
  });

  // ─── getLessonsLearned ───────────────────────────────
  test('extracts Lessons Learned section from SOUL.md', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => true,
          text: async () => '# Soul\n\n## Lessons Learned\n\n- lesson 1\n- lesson 2',
        }) as unknown as ReturnType<typeof Bun.file>,
    );

    const lessons = await loader.getLessonsLearned();
    expect(lessons).toContain('lesson 1');
  });

  test('returns empty string when no Lessons Learned section', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => true,
          text: async () => '# Soul\n\nNo lessons here.',
        }) as unknown as ReturnType<typeof Bun.file>,
    );

    const lessons = await loader.getLessonsLearned();
    expect(lessons).toBe('');
  });

  // ─── updateUserProfile ───────────────────────────────
  test('writes to local file and syncs to VikingFS', async () => {
    const bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    await loader.updateUserProfile('# New Profile');

    expect(bunWriteSpy).toHaveBeenCalledWith('./config/USER.md', '# New Profile');
    expect(ov.write).toHaveBeenCalled();
    bunWriteSpy.mockRestore();
  });

  test('continues even if VikingFS sync fails', async () => {
    const bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);
    (ov.write as ReturnType<typeof mock>).mockRejectedValue(new Error('network'));

    // Should not throw
    await loader.updateUserProfile('# Profile');
    bunWriteSpy.mockRestore();
  });
});
