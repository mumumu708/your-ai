import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ConfigLoader } from './config-loader';
import type { OpenVikingClient } from './openviking/openviking-client';
import { UserConfigLoader } from './user-config-loader';

function createMockOV(): OpenVikingClient {
  return {
    tryRead: mock(async () => null),
    write: mock(async () => {}),
    ls: mock(async () => []),
  } as unknown as OpenVikingClient;
}

function createMockGlobalLoader(): ConfigLoader {
  return {
    loadFile: mock(async (filename: string) => `<!-- ${filename} global -->`),
  } as unknown as ConfigLoader;
}

describe('UserConfigLoader', () => {
  let ov: OpenVikingClient;
  let globalLoader: ConfigLoader;
  let loader: UserConfigLoader;
  let bunFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    ov = createMockOV();
    globalLoader = createMockGlobalLoader();
    loader = new UserConfigLoader('user1', ov, globalLoader, '/workspace/user1');
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
  test('loads all 4 config files', async () => {
    const config = await loader.loadAll();
    expect(config).toHaveProperty('soul');
    expect(config).toHaveProperty('identity');
    expect(config).toHaveProperty('user');
    expect(config).toHaveProperty('agents');
  });

  test('returns cached result within TTL', async () => {
    await loader.loadAll();
    (globalLoader.loadFile as ReturnType<typeof mock>).mockClear();
    const config = await loader.loadAll();
    expect(globalLoader.loadFile).not.toHaveBeenCalled();
    expect(config).toHaveProperty('soul');
  });

  test('forceRefresh bypasses cache', async () => {
    await loader.loadAll();
    (globalLoader.loadFile as ReturnType<typeof mock>).mockClear();
    await loader.loadAll(true);
    expect(globalLoader.loadFile).toHaveBeenCalled();
  });

  test('invalidateCache forces re-read', async () => {
    await loader.loadAll();
    loader.invalidateCache();
    (globalLoader.loadFile as ReturnType<typeof mock>).mockClear();
    await loader.loadAll();
    expect(globalLoader.loadFile).toHaveBeenCalled();
  });

  test('loads from local file when it exists', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => true,
          text: async () => '# Local User Config',
        }) as unknown as ReturnType<typeof Bun.file>,
    );

    const config = await loader.loadAll(true);
    expect(config.soul).toBe('# Local User Config');
  });

  test('loads from VikingFS when local missing and remote exists', async () => {
    (ov.ls as ReturnType<typeof mock>).mockResolvedValue([
      { name: 'SOUL.md', uri: 'v://u', type: 'file' },
      { name: 'IDENTITY.md', uri: 'v://u', type: 'file' },
      { name: 'USER.md', uri: 'v://u', type: 'file' },
      { name: 'AGENTS.md', uri: 'v://u', type: 'file' },
    ]);
    (ov.tryRead as ReturnType<typeof mock>).mockResolvedValue('# Viking User Config');

    const config = await loader.loadAll(true);
    expect(config.soul).toBe('# Viking User Config');
  });

  test('skips VikingFS when file not in remote listing', async () => {
    // ls returns empty — no remote files
    (ov.ls as ReturnType<typeof mock>).mockResolvedValue([]);
    await loader.loadAll(true);
    // Should fall back to global without calling tryRead
    expect(ov.tryRead).not.toHaveBeenCalled();
  });

  test('handles ls failure gracefully', async () => {
    (ov.ls as ReturnType<typeof mock>).mockRejectedValue(new Error('network'));
    // When ls fails, remoteFiles = empty set, so it should skip VikingFS and fall back to global
    const config = await loader.loadAll(true);
    expect(config.soul).toContain('global');
  });

  test('ignores VikingFS content starting with <!--', async () => {
    (ov.ls as ReturnType<typeof mock>).mockResolvedValue([
      { name: 'SOUL.md', uri: 'v://u', type: 'file' },
    ]);
    (ov.tryRead as ReturnType<typeof mock>).mockResolvedValue('<!-- not found -->');

    const config = await loader.loadAll(true);
    expect(config.soul).toContain('global');
  });

  test('falls back to global config', async () => {
    const config = await loader.loadAll(true);
    expect(config.soul).toContain('global');
  });

  // ─── writeConfig ─────────────────────────────────────
  test('writes to local and syncs to VikingFS', async () => {
    const bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    await loader.writeConfig('USER.md', '# Updated');
    expect(bunWriteSpy).toHaveBeenCalled();
    expect(ov.write).toHaveBeenCalled();
    bunWriteSpy.mockRestore();
  });

  test('continues when VikingFS sync fails', async () => {
    const bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);
    (ov.write as ReturnType<typeof mock>).mockRejectedValue(new Error('network'));

    // Should not throw
    await loader.writeConfig('USER.md', '# Updated');
    bunWriteSpy.mockRestore();
  });

  // ─── hasUserConfig ───────────────────────────────────
  test('returns true when local file exists', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => true,
        }) as unknown as ReturnType<typeof Bun.file>,
    );

    expect(await loader.hasUserConfig('SOUL.md')).toBe(true);
  });

  test('returns true when file exists on VikingFS', async () => {
    (ov.ls as ReturnType<typeof mock>).mockResolvedValue([
      { name: 'SOUL.md', uri: 'v://u', type: 'file' },
    ]);

    expect(await loader.hasUserConfig('SOUL.md')).toBe(true);
  });

  test('returns false when file not found anywhere', async () => {
    expect(await loader.hasUserConfig('MISSING.md')).toBe(false);
  });

  test('returns false when local file check throws and VikingFS ls fails', async () => {
    bunFileSpy.mockRestore();
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(() => {
      throw new Error('fs error');
    });
    (ov.ls as ReturnType<typeof mock>).mockRejectedValue(new Error('network'));

    expect(await loader.hasUserConfig('SOUL.md')).toBe(false);
  });

  // ─── getLocalDir ─────────────────────────────────────
  test('returns local directory path', () => {
    expect(loader.getLocalDir()).toContain('memory');
  });
});
