import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type {
  IConfigLoader,
  IOpenVikingClient,
  IUserConfigLoader,
} from '../shared/memory/memory.interfaces';
import type { ExtractedLesson } from './lesson-extractor';
import { LessonsLearnedUpdater } from './lessons-updater';

function createMockOV(): IOpenVikingClient {
  return {
    write: mock(async () => {}),
  } as unknown as IOpenVikingClient;
}

function createMockConfigLoader(soulContent = '# Soul\n\n## Lessons Learned\n'): IConfigLoader {
  return {
    loadAll: mock(async () => ({
      soul: soulContent,
      identity: '',
      user: '',
      agents: '',
    })),
    invalidateCache: mock(() => {}),
  } as unknown as IConfigLoader;
}

function createMockUserConfigLoader(
  soulContent = '# Soul\n\n## Lessons Learned\n',
): IUserConfigLoader {
  return {
    loadAll: mock(async () => ({
      soul: soulContent,
      identity: '',
      user: '',
      agents: '',
    })),
    writeConfig: mock(async () => {}),
    invalidateCache: mock(() => {}),
  } as unknown as IUserConfigLoader;
}

function lesson(overrides: Partial<ExtractedLesson> = {}): ExtractedLesson {
  return {
    action: 'do something',
    category: 'instruction',
    lesson: 'A new lesson learned today',
    ...overrides,
  };
}

describe('LessonsLearnedUpdater', () => {
  let bunWriteSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    if (bunWriteSpy) bunWriteSpy.mockRestore();
  });

  // ─── addLesson ───────────────────────────────────────
  test('adds a lesson via global config', async () => {
    const ov = createMockOV();
    const configLoader = createMockConfigLoader();
    bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    const result = await updater.addLesson(lesson());

    expect(result).toBe(true);
    expect(bunWriteSpy).toHaveBeenCalled();
    expect(configLoader.invalidateCache).toHaveBeenCalled();
  });

  test('adds a lesson via user config loader', async () => {
    const ov = createMockOV();
    const configLoader = createMockConfigLoader();
    const userConfigLoader = createMockUserConfigLoader();

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    const result = await updater.addLesson(lesson(), userConfigLoader);

    expect(result).toBe(true);
    expect(userConfigLoader.writeConfig).toHaveBeenCalled();
    expect(userConfigLoader.invalidateCache).toHaveBeenCalled();
  });

  test('skips duplicate lessons', async () => {
    const ov = createMockOV();
    const existingSoul =
      '# Soul\n\n## Lessons Learned\n\n### instruction\n- [2025-01-01] A new lesson learned today\n';
    const configLoader = createMockConfigLoader(existingSoul);
    bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    const result = await updater.addLesson(lesson());

    expect(result).toBe(false);
  });

  test('syncs to VikingFS when using global config', async () => {
    const ov = createMockOV();
    const configLoader = createMockConfigLoader();
    bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    await updater.addLesson(lesson());

    expect(ov.write).toHaveBeenCalled();
  });

  test('continues if VikingFS sync fails', async () => {
    const ov = createMockOV();
    (ov.write as ReturnType<typeof mock>).mockRejectedValue(new Error('network'));
    const configLoader = createMockConfigLoader();
    bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    const result = await updater.addLesson(lesson());

    expect(result).toBe(true);
  });

  // ─── parseLessons ────────────────────────────────────
  test('parses lessons from SOUL.md', () => {
    const ov = createMockOV();
    const configLoader = createMockConfigLoader();
    const updater = new LessonsLearnedUpdater(ov, configLoader);

    const soul = `# Soul

## Lessons Learned

### 编码与技术
- [2025-01-01] 使用 strict mode
- [2025-01-02] 注意类型安全

### 偏好
- [2025-01-03] 用户喜欢简洁
`;

    const { before, entries } = updater.parseLessons(soul);
    expect(before).toContain('## Lessons Learned');
    expect(entries).toHaveLength(3);
    expect(entries[0].category).toBe('编码与技术');
    expect(entries[2].category).toBe('偏好');
  });

  test('parses SOUL.md without Lessons Learned section', () => {
    const ov = createMockOV();
    const configLoader = createMockConfigLoader();
    const updater = new LessonsLearnedUpdater(ov, configLoader);

    const { before, entries } = updater.parseLessons('# Soul\nNo lessons here.');
    expect(before).toBe('# Soul\nNo lessons here.');
    expect(entries).toHaveLength(0);
  });

  // ─── enforceCapacity ─────────────────────────────────
  test('enforces per-category limit of 20', async () => {
    const ov = createMockOV();
    // Create SOUL with 20 existing entries in one category
    const existingEntries = Array.from(
      { length: 20 },
      (_, i) => `- [2025-01-${String(i + 1).padStart(2, '0')}] lesson ${i}`,
    ).join('\n');
    const soul = `# Soul\n\n## Lessons Learned\n\n### instruction\n${existingEntries}\n`;
    const configLoader = createMockConfigLoader(soul);
    bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    const result = await updater.addLesson(
      lesson({ lesson: 'A completely unique brand new lesson entry' }),
    );

    // Should succeed (oldest evicted)
    expect(result).toBe(true);
  });

  // ─── rebuildSoul ─────────────────────────────────────
  test('rebuilds SOUL.md with proper formatting', async () => {
    const ov = createMockOV();
    const configLoader = createMockConfigLoader();
    bunWriteSpy = spyOn(Bun, 'write').mockResolvedValue(100 as unknown as number);

    const updater = new LessonsLearnedUpdater(ov, configLoader);
    await updater.addLesson(lesson({ category: 'preference', lesson: 'Use short answers' }));

    const writtenContent = bunWriteSpy.mock.calls[0]?.[1] as string;
    expect(writtenContent).toContain('### preference');
    expect(writtenContent).toContain('Use short answers');
  });
});
