/**
 * DD-022 Knowledge Loop Restructure — Integration Tests
 *
 * INT-01~12: Covers learning pipeline, memory snapshot, skill recommendation,
 * digest pipeline, and module migration regression.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import {
  type DigestableItem,
  clusterItems,
  distillClusters,
  writeInsights,
} from '../kernel/evolution/digest/digest-pipeline';
import { shouldTriggerDigest } from '../kernel/evolution/digest/digest-trigger';
import { LessonsLearnedUpdater } from '../kernel/evolution/learning/lessons-updater';
import { PostResponseAnalyzer } from '../kernel/evolution/learning/post-response-analyzer';
import type { OpenVikingClient } from '../kernel/memory/openviking/openviking-client';
import { buildMemorySnapshot } from '../kernel/prompt/memory-snapshot-builder';
import type { MemoryItem } from '../kernel/prompt/memory-snapshot-builder';
import { buildTurnContext } from '../kernel/prompt/turn-context-builder';
import type { SkillManager } from '../kernel/skills/skill-manager';
import { type SkillPatch, SkillPatcher } from '../kernel/skills/skill-patcher';
import type {
  IConfigLoader,
  IOpenVikingClient,
  IUserConfigLoader,
} from '../shared/memory/memory.interfaces';

// ─── Helpers ──────────────────────────────────────────────

function createMockOV(): IOpenVikingClient {
  return { write: mock(async () => {}) } as unknown as IOpenVikingClient;
}

function createMockConfigLoader(soul = '# SOUL\n## Lessons Learned\n'): IConfigLoader {
  const soulContent = soul;
  return {
    loadAll: mock(async () => ({
      soul: soulContent,
      identity: 'Test Agent',
      user: '',
      agents: '',
    })),
    invalidateCache: mock(() => {}),
    getLessonsLearned: mock(async () => ''),
    updateUserProfile: mock(async () => {}),
  };
}

function createMockUserConfigLoader(
  soul = '# SOUL\n## Lessons Learned\n',
): IUserConfigLoader & { _getSoul(): string } {
  const state = { soul };
  const obj = {
    loadAll: async () => ({
      soul: state.soul,
      identity: 'Test Agent',
      user: '',
      agents: '',
    }),
    writeConfig: async (_filename: string, content: string) => {
      state.soul = content;
    },
    invalidateCache: () => {},
    _getSoul: () => state.soul,
  };
  // Wrap with spies for call tracking
  obj.loadAll = mock(obj.loadAll);
  obj.writeConfig = mock(obj.writeConfig);
  obj.invalidateCache = mock(obj.invalidateCache);
  return obj;
}

function createMockSkillManager(): SkillManager {
  return {
    addSkill: mock(() => ({ command: 'ok' })),
    removeSkill: mock(() => true),
    getSkill: mock(() => null),
    listSkills: mock(() => []),
  } as unknown as SkillManager;
}

// ─── INT-01~03: Learning Pipeline Integration ──────────────────

describe('DD-022 学习管道集成', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  test('INT-01: 纠错消息 → PostResponseAnalyzer → SOUL.md 新增 lesson', async () => {
    const ov = createMockOV();
    const userConfig = createMockUserConfigLoader('# SOUL\n## Lessons Learned\n');
    const configLoader = createMockConfigLoader();
    const updater = new LessonsLearnedUpdater(ov, configLoader);
    const analyzer = new PostResponseAnalyzer({ lessonsUpdater: updater });

    // User corrects: "不是 Python，以后都用 TypeScript"
    const result = await analyzer.analyzeExchange(
      'user1',
      '不是 Python，以后都用 TypeScript',
      '好的，我用 Python 来写',
      [
        { role: 'user', content: '帮我写个脚本' },
        { role: 'assistant', content: '好的，我用 Python 来写' },
      ],
      userConfig as any,
    );

    // Should detect correction and store lesson
    expect(result).not.toBeNull();
    expect(userConfig.writeConfig).toHaveBeenCalled();

    // Verify SOUL.md content contains the lesson
    const newSoul = userConfig._getSoul();
    expect(newSoul).toContain('## Lessons Learned');
    expect(newSoul).toContain('TypeScript');
  });

  test('INT-02: 纠错含可复用方法 → SkillPatch 传递到 skill-patcher', async () => {
    const skillManager = createMockSkillManager();
    const patcher = new SkillPatcher({
      skillManager,
      workspaceDir: '/test/workspace',
    });

    // Simulate post-response-analyzer outputting a SkillPatch
    const patches: SkillPatch[] = [
      {
        action: 'create',
        skillName: 'ts-type-error-debug',
        content:
          '---\nname: ts-type-error-debug\ndescription: TS 类型错误调试流程\n---\n\n1. 检查类型定义\n2. 运行 tsc --noEmit\n3. 查看错误堆栈',
        source: 'evolution',
        confidence: 0.85,
      },
    ];

    const result = await patcher.applyPatches(patches);

    expect(result.applied).toEqual(['ts-type-error-debug']);
    expect(skillManager.addSkill).toHaveBeenCalledWith(
      '/test/workspace',
      'ts-type-error-debug',
      expect.objectContaining({ content: expect.stringContaining('TS 类型错误调试流程') }),
    );
  });

  test('INT-03: 连续发送 21 条同 category lesson → 最多 20 条，FIFO 淘汰', async () => {
    const ov = createMockOV();
    const userConfig = createMockUserConfigLoader('# SOUL\n## Lessons Learned\n');
    const configLoader = createMockConfigLoader();
    const updater = new LessonsLearnedUpdater(ov, configLoader);

    // Add 21 distinctly different lessons in same category
    const topics = [
      '回复语言必须用中文',
      '代码风格用 camelCase',
      '缩进用 2 空格',
      '不要使用 any 类型',
      '优先用 const 而非 let',
      '函数名用动词开头',
      '错误处理必须用 try-catch',
      '日志格式用 JSON',
      '测试覆盖率要求 80%',
      '提交信息用英文',
      '分支名用 kebab-case',
      'PR 标题不超过 70 字符',
      '不要在 main 分支直接提交',
      'API 必须有认证',
      '密码必须加盐哈希',
      '超时设置为 30 秒',
      '重试最多 3 次',
      '缓存过期时间 1 小时',
      '文件大小限制 10MB',
      '并发连接数限制 100',
      '最终一致性延迟容忍 5 秒',
    ];
    for (let i = 0; i < 21; i++) {
      const lesson = {
        action: 'add',
        category: 'preference' as const,
        lesson: topics[i]!,
      };
      await updater.addLesson(lesson, userConfig as any);
    }

    // Parse resulting SOUL.md
    const soul = userConfig._getSoul();
    const lessonLines = soul.split('\n').filter((l: string) => l.trim().startsWith('- ['));

    // Should have exactly 20 entries (21st triggers capacity enforcement)
    expect(lessonLines.length).toBe(20);

    // Newest entries kept, oldest evicted — entry 21 (newest) survives, entry 1 (oldest) is evicted
    expect(soul).toContain('最终一致性延迟容忍 5 秒');
    expect(soul).not.toContain('回复语言必须用中文');
  });
});

// ─── INT-04~05: Memory Snapshot Integration ──────────────────

describe('DD-022 Memory Snapshot 集成', () => {
  test('INT-04: 30 条不同 category/importance 的 memory → snapshot 覆盖 6 category', () => {
    const now = Date.now();
    const memories: MemoryItem[] = [];

    const categories: Array<MemoryItem['category']> = [
      'preference',
      'fact',
      'context',
      'instruction',
      'insight',
      'task',
    ];

    // 5 memories per category, varying importance and recency
    for (const cat of categories) {
      for (let i = 0; i < 5; i++) {
        memories.push({
          content: `${cat} 记忆 ${i + 1}`,
          category: cat,
          importance: 0.3 + i * 0.15,
          updatedAt: now - i * 5 * 86_400_000, // 0, 5, 10, 15, 20 days ago
        });
      }
    }

    const snapshot = buildMemorySnapshot(memories);

    // All 6 categories should appear
    expect(snapshot).toContain('## 用户偏好');
    expect(snapshot).toContain('## 关键事实');
    expect(snapshot).toContain('## 项目上下文');
    expect(snapshot).toContain('## 行为指令');
    expect(snapshot).toContain('## 总结洞察');
    expect(snapshot).toContain('## 活跃任务');

    // Line count constraint
    const lines = snapshot.split('\n');
    expect(lines.length).toBeLessThanOrEqual(200);
  });

  test('INT-05: 大量低 importance 旧数据 + 少量高 importance 新数据 → 优先包含后者', () => {
    const now = Date.now();
    const memories: MemoryItem[] = [];

    // 20 old low-importance facts
    for (let i = 0; i < 20; i++) {
      memories.push({
        content: `旧数据 ${i}`,
        category: 'fact',
        importance: 0.1,
        updatedAt: now - 90 * 86_400_000, // 90 days ago
        accessCount: 0,
      });
    }

    // 3 new high-importance facts
    for (let i = 0; i < 3; i++) {
      memories.push({
        content: `新重要数据 ${i}`,
        category: 'fact',
        importance: 0.95,
        updatedAt: now,
        accessCount: 5,
      });
    }

    const snapshot = buildMemorySnapshot(memories);

    // New high-importance data should appear first in the fact section
    const factSection = snapshot.split('## 关键事实')[1]?.split('##')[0] ?? '';
    const factLines = factSection.split('\n').filter((l) => l.startsWith('- '));

    // First items should be the new important ones
    expect(factLines[0]).toContain('新重要数据');
    expect(factLines[1]).toContain('新重要数据');
    expect(factLines[2]).toContain('新重要数据');
  });
});

// ─── INT-06~07: Skill Semantic Recommendation Integration ──────

describe('DD-022 Skill 语义推荐集成', () => {
  test('INT-06: 有匹配 skill 时 → turn-context 包含 <skill-recommendation>', () => {
    const result = buildTurnContext({
      skillRecommendations: [
        { name: 'debug-ts', description: 'TypeScript 类型错误调试' },
        { name: 'graphify', description: '知识图谱构建工具' },
        { name: 'summarize', description: '文本摘要生成' },
      ],
    });

    expect(result.content).toContain('<skill-recommendation>');
    expect(result.content).toContain('/debug-ts');
    expect(result.content).toContain('/graphify');
    expect(result.content).toContain('/summarize');
    expect(result.content).toContain('skill_view');
    expect(result.content).toContain('</skill-recommendation>');
  });

  test('INT-07: 无匹配 skill 时 → turn-context 不包含 <skill-recommendation>', () => {
    const result = buildTurnContext({
      skillRecommendations: [],
    });

    expect(result.content).not.toContain('<skill-recommendation>');
  });
});

// ─── INT-08~10: Digest Integration ──────────────────

describe('DD-022 Digest 集成', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  test('INT-08: 25 条低 importance 碎片 → digest 触发 → insight 写入 + 原始标记 digested', async () => {
    // Phase 1: Verify trigger condition
    expect(shouldTriggerDigest({ undigestedCount: 25, lastDigestAt: Date.now() })).toBe(true);

    // Phase 2: Cluster items
    const items: DigestableItem[] = Array.from({ length: 25 }, (_, i) => ({
      uri: `viking://mem/user1/frag-${i}`,
      content: `Rust 所有权相关碎片 ${i}`,
      importance: 0.3,
      accessCount: 0,
    }));

    const clusters = clusterItems(items);
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    // All items should cluster together (same topic "Rust")
    const totalClustered = clusters.reduce((sum, c) => sum + c.items.length, 0);
    expect(totalClustered).toBeGreaterThanOrEqual(3);

    // Phase 3: Distill
    const llmDistill = mock(async (_content: string) => ({
      topic: 'Rust 所有权',
      insight: 'Rust 通过所有权、借用和生命周期实现零成本内存安全',
      questions: ['如何处理循环引用？'],
      relatedSkills: [],
      sourceUris: [] as string[],
    }));

    const insights = await distillClusters(clusters, llmDistill);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights[0]?.topic).toBe('Rust 所有权');

    // Phase 4: Write insights
    const ovClient = { write: mock(async () => {}) } as unknown as OpenVikingClient;
    const written = await writeInsights(ovClient, 'user1', insights);
    expect(written).toBeGreaterThanOrEqual(1);
    expect(ovClient.write).toHaveBeenCalledWith(
      expect.stringContaining('viking://mem/user1/insight/'),
      expect.stringContaining('所有权'),
    );
  });

  test('INT-09: 5 条碎片（< 20 阈值）→ digest 不触发', () => {
    expect(shouldTriggerDigest({ undigestedCount: 5, lastDigestAt: Date.now() })).toBe(false);
  });

  test('INT-10: digest 完成后新 session → per-turn 注入包含 <digest-available>', () => {
    const result = buildTurnContext({
      digestInsights: [
        { topic: 'Rust 所有权', preview: '关于借用和生命周期的碎片已聚类提炼' },
        { topic: 'TypeScript 技巧', preview: '类型体操相关笔记汇总' },
      ],
    });

    expect(result.content).toContain('<digest-available>');
    expect(result.content).toContain('Rust 所有权');
    expect(result.content).toContain('TypeScript 技巧');
    expect(result.content).toContain('帮我梳理一下');
    expect(result.content).toContain('</digest-available>');
  });
});

// ─── INT-11~12: Module Migration Regression ──────────────────

describe('DD-022 模块迁移回归', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  test('INT-11: config-loader 迁移后 → 通过 prompt/ 路径加载 AIEOS → 行为不变', async () => {
    // Verify ConfigLoader can be imported from new location
    const { ConfigLoader: CL } = await import('../kernel/prompt/config-loader');
    expect(CL).toBeDefined();

    // Verify it constructs and loadAll returns correct shape
    const mockOV = {
      tryRead: mock(async () => null),
      write: mock(async () => {}),
    } as unknown as OpenVikingClient;

    const loader = new CL(mockOV);
    const config = await loader.loadAll();

    // Should return AIEOSConfig with all 4 fields
    expect(config).toHaveProperty('soul');
    expect(config).toHaveProperty('identity');
    expect(config).toHaveProperty('user');
    expect(config).toHaveProperty('agents');
  });

  test('INT-12: lessons 迁移后 → 通过 evolution/learning/ 路径执行纠错管道 → 行为不变', async () => {
    // Verify all lesson modules import from new location
    const { detectErrorSignal: detect } = await import(
      '../kernel/evolution/learning/error-detector'
    );
    const { extractLesson: extract } = await import(
      '../kernel/evolution/learning/lesson-extractor'
    );
    const { LessonsLearnedUpdater: Updater } = await import(
      '../kernel/evolution/learning/lessons-updater'
    );

    expect(detect).toBeFunction();
    expect(extract).toBeFunction();
    expect(Updater).toBeDefined();

    // Execute full correction pipeline
    const signal = detect('不是 Python，用 TypeScript', [
      { role: 'user', content: '帮我写脚本' },
      { role: 'assistant', content: '好的用 Python' },
    ]);

    expect(signal).not.toBeNull();
    expect(signal?.type).toBe('correction');

    const lesson = await extract(signal!);
    expect(lesson).toHaveProperty('lesson');
    expect(lesson).toHaveProperty('category');
    expect(lesson).toHaveProperty('action');

    // Verify updater writes to SOUL.md
    const ov = createMockOV();
    const userConfig = createMockUserConfigLoader('# SOUL\n## Lessons Learned\n');
    const configLoader = createMockConfigLoader();
    const updater = new Updater(ov, configLoader);

    const added = await updater.addLesson(lesson, userConfig as any);
    expect(added).toBe(true);

    const soul = userConfig._getSoul();
    expect(soul).toContain('## Lessons Learned');
  });
});
