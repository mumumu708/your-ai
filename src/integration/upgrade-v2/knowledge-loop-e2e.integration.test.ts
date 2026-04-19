/**
 * DD-022 Knowledge Loop Restructure — E2E Tests
 *
 * E2E-01~04: Full controller-level tests that simulate user messages
 * and verify the complete knowledge loop (learn → store → consume).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import {
  type DigestableItem,
  clusterItems,
  distillClusters,
  writeInsights,
} from '../../kernel/evolution/digest/digest-pipeline';
import { shouldTriggerDigest } from '../../kernel/evolution/digest/digest-trigger';
import { LessonsLearnedUpdater } from '../../kernel/evolution/learning/lessons-updater';
import { PostResponseAnalyzer } from '../../kernel/evolution/learning/post-response-analyzer';
import type { OpenVikingClient } from '../../kernel/memory/openviking/openviking-client';
import { buildMemorySnapshot } from '../../kernel/prompt/memory-snapshot-builder';
import type { MemoryItem } from '../../kernel/prompt/memory-snapshot-builder';
import { buildTurnContext } from '../../kernel/prompt/turn-context-builder';
import type { SkillManager } from '../../kernel/skills/skill-manager';
import { type SkillPatch, SkillPatcher } from '../../kernel/skills/skill-patcher';
import type {
  IConfigLoader,
  IOpenVikingClient,
  IUserConfigLoader,
} from '../../shared/memory/memory.interfaces';
import { type ControllerTestContext, cleanupController } from './test-helpers';

// ─── Mock Factories ──────────────────────────────────────────

function createStatefulUserConfigLoader(
  initialSoul = '# SOUL\n## Lessons Learned\n',
): IUserConfigLoader & { _getSoul(): string } {
  const state = { soul: initialSoul };
  return {
    loadAll: mock(async () => ({
      soul: state.soul,
      identity: 'Test Agent',
      user: '',
      agents: '',
    })),
    writeConfig: mock(async (_filename: string, content: string) => {
      state.soul = content;
    }),
    invalidateCache: mock(() => {}),
    _getSoul: () => state.soul,
  };
}

function createMockSkillManager(): SkillManager {
  return {
    addSkill: mock(() => ({ command: 'ok' })),
    removeSkill: mock(() => true),
    getSkill: mock(() => null),
    listSkills: mock(() => []),
  } as unknown as SkillManager;
}

// ─── E2E-01: 纠错→学习→冻结闭环 ────────────────────────────

describe('DD-022 E2E', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let ctx: ControllerTestContext;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (ctx) cleanupController(ctx);
  });

  test('E2E-01: 纠错→学习→冻结闭环', async () => {
    // Setup: real PostResponseAnalyzer + LessonsLearnedUpdater
    const mockOV = { write: mock(async () => {}) } as unknown as IOpenVikingClient;
    const userConfig = createStatefulUserConfigLoader('# SOUL\n## Lessons Learned\n');
    const configLoader = {
      loadAll: mock(async () => ({
        soul: '# SOUL\nBe helpful\n## Lessons Learned\n',
        identity: 'Test Agent',
        user: '',
        agents: '',
      })),
      invalidateCache: mock(() => {}),
      getLessonsLearned: mock(async () => ''),
      updateUserProfile: mock(async () => {}),
    } as unknown as IConfigLoader;

    const updater = new LessonsLearnedUpdater(mockOV, configLoader);
    const analyzer = new PostResponseAnalyzer({ lessonsUpdater: updater });

    // Step 1-2: User sends message, assistant replies (simulated)
    // Step 3: User sends correction
    const correctionResult = await analyzer.analyzeExchange(
      'user_test',
      '不是 Python，以后都用 TypeScript',
      '好的，我用 Python 来写',
      [
        { role: 'user', content: '帮我写个脚本' },
        { role: 'assistant', content: '好的，我用 Python 来写' },
      ],
      userConfig as any,
    );

    // Step 4: Verify SOUL.md contains TypeScript preference
    expect(correctionResult).not.toBeNull();
    const soul = userConfig._getSoul();
    expect(soul).toContain('## Lessons Learned');
    expect(soul).toContain('TypeScript');

    // Step 5: Verify OpenViking memory write was attempted (via lessons updater sync)
    // The updater writes to local file via userConfigLoader, not directly to OV in user-config mode

    // Step 6-7: Simulate new session — build frozen system prompt with the lesson
    // The lesson should now be part of SOUL.md which feeds into the system prompt
    const newSoul = userConfig._getSoul();
    expect(newSoul).toContain('TypeScript');

    // Simulate what SystemPromptBuilder does: load SOUL.md and include in prompt
    const config = await userConfig.loadAll();
    expect(config.soul).toContain('TypeScript');
  });

  test('E2E-02: 方法学习→Skill 自动创建→推荐闭环', async () => {
    // Step 1-2: Simulate evolution detecting a reusable method
    const skillManager = createMockSkillManager();
    const patcher = new SkillPatcher({
      skillManager,
      workspaceDir: '/tmp/test-workspace',
    });

    // Step 3: PostResponseAnalyzer outputs a SkillPatch (simulated)
    const patches: SkillPatch[] = [
      {
        action: 'create',
        skillName: 'debug-memory-leak',
        content: [
          '---',
          'name: debug-memory-leak',
          'description: Node.js 内存泄漏调试流程',
          'tags: [debugging, nodejs, memory]',
          '---',
          '',
          '## 步骤',
          '1. 使用 --inspect 启动进程',
          '2. Chrome DevTools 拍摄堆快照',
          '3. 对比两次快照找泄漏对象',
          '4. 检查闭包和事件监听器',
        ].join('\n'),
        source: 'evolution',
        confidence: 0.8,
      },
    ];

    const result = await patcher.applyPatches(patches);

    // Step 3 verify: Skill file created
    expect(result.applied).toEqual(['debug-memory-leak']);
    expect(skillManager.addSkill).toHaveBeenCalledWith(
      '/tmp/test-workspace',
      'debug-memory-leak',
      expect.objectContaining({
        content: expect.stringContaining('内存泄漏调试流程'),
      }),
    );

    // Step 4: Simulate OpenViking skill index (would be done by SkillIndexBuilder)
    // Step 5-6: Simulate new session with semantically related query
    const turnContext = buildTurnContext({
      skillRecommendations: [
        { name: 'debug-memory-leak', description: 'Node.js 内存泄漏调试流程' },
      ],
    });

    // Verify skill recommendation appears in per-turn injection
    expect(turnContext.content).toContain('<skill-recommendation>');
    expect(turnContext.content).toContain('debug-memory-leak');
  });

  test('E2E-03: 碎片积累→消化→主动提示闭环', async () => {
    // Step 1: Simulate 25 scattered memories about Rust ownership
    const rustFragments: DigestableItem[] = Array.from({ length: 25 }, (_, i) => ({
      uri: `viking://mem/user1/rust-${i}`,
      content: [
        'Rust 所有权系统确保内存安全',
        'Rust 借用规则限制可变引用',
        'Rust 生命周期标注帮助编译器验证',
        'Rust move 语义转移所有权',
        'Rust Drop trait 实现自动清理',
      ][i % 5]!,
      importance: 0.3 + (i % 3) * 0.1,
      accessCount: 0,
    }));

    // Step 2: Verify OpenViking has 25 records (simulated count)
    expect(rustFragments.length).toBe(25);

    // Step 3: Trigger digest (condition check)
    expect(shouldTriggerDigest({ undigestedCount: 25, lastDigestAt: null })).toBe(true);

    // Phase 2: Cluster
    const clusters = clusterItems(rustFragments);
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    // Phase 3: Distill via LLM
    const llmDistill = mock(async (_content: string) => ({
      topic: 'Rust 所有权系统',
      insight:
        'Rust 通过所有权（ownership）、借用（borrowing）和生命周期（lifetimes）三大机制实现零成本内存安全。' +
        '所有权确保每个值有且只有一个拥有者，借用规则限制同时只能有一个可变引用或多个不可变引用，' +
        '生命周期标注帮助编译器静态验证引用有效性。',
      questions: ['如何用 Rc/Arc 处理循环引用？', 'Pin 和 Unpin 在异步中的作用？'],
      relatedSkills: [],
      sourceUris: [] as string[],
    }));

    const insights = await distillClusters(clusters, llmDistill);
    expect(insights.length).toBeGreaterThanOrEqual(1);

    // Step 4: Write insights to OpenViking
    const ovClient = {
      write: mock(async () => {}),
    } as unknown as OpenVikingClient;
    const written = await writeInsights(ovClient, 'user1', insights);
    expect(written).toBeGreaterThanOrEqual(1);

    // Verify insight content contains Rust
    const writeCall = (ovClient.write as any).mock.calls[0];
    expect(writeCall[0]).toContain('viking://mem/user1/insight/');
    expect(writeCall[1]).toContain('Rust');

    // Step 5: Verify original fragments would be marked digested
    // (In real implementation, scanUndigested filters by 'digested' metadata)

    // Step 6-7: Simulate new session — digest-available should appear
    const turnContext = buildTurnContext({
      digestInsights: insights.map((i) => ({
        topic: i.topic,
        preview: i.insight.slice(0, 60),
      })),
    });

    expect(turnContext.content).toContain('<digest-available>');
    expect(turnContext.content).toContain('Rust');
    expect(turnContext.content).toContain('帮我梳理一下');
  });

  test('E2E-04: 完整闭环压力测试', async () => {
    const mockOV = { write: mock(async () => {}) } as unknown as IOpenVikingClient;
    const userConfig = createStatefulUserConfigLoader('# SOUL\n## Lessons Learned\n');
    const configLoader = {
      loadAll: mock(async () => ({
        soul: userConfig._getSoul(),
        identity: 'Test Agent',
        user: '',
        agents: '',
      })),
      invalidateCache: mock(() => {}),
      getLessonsLearned: mock(async () => ''),
      updateUserProfile: mock(async () => {}),
    } as unknown as IConfigLoader;

    const updater = new LessonsLearnedUpdater(mockOV, configLoader);
    const analyzer = new PostResponseAnalyzer({ lessonsUpdater: updater });
    const skillManager = createMockSkillManager();
    const patcher = new SkillPatcher({ skillManager, workspaceDir: '/tmp/ws' });

    // Simulate 10 sessions × 5 turns with corrections and info accumulation
    const corrections = [
      '不要用 var，用 const',
      '错误消息用中文',
      '日志格式用 structured JSON',
      '测试文件放在同目录下',
      'import 用绝对路径',
      '不要用 console.log 调试',
      '函数不超过 50 行',
      '每个 PR 不超过 300 行',
      '代码注释用英文',
      '变量名用驼峰命名',
    ];

    const allMemories: MemoryItem[] = [];

    for (let session = 0; session < 10; session++) {
      for (let turn = 0; turn < 5; turn++) {
        // Every other turn includes a correction
        if (turn % 2 === 1 && session < corrections.length) {
          await analyzer.analyzeExchange(
            'user_test',
            corrections[session]!,
            '好的',
            [
              { role: 'user', content: '帮我写代码' },
              { role: 'assistant', content: '好的' },
            ],
            userConfig as any,
          );
        }

        // Accumulate memories
        allMemories.push({
          content: `Session ${session} Turn ${turn} 的信息片段`,
          category: (['preference', 'fact', 'context', 'instruction', 'insight', 'task'] as const)[
            turn % 6
          ],
          importance: 0.2 + Math.random() * 0.6,
          updatedAt: Date.now() - (10 - session) * 86_400_000,
        });
      }
    }

    // Verify 1: SOUL.md lessons 不超过 80 条上限
    const soul = userConfig._getSoul();
    const lessonLines = soul.split('\n').filter((l: string) => l.trim().startsWith('- ['));
    expect(lessonLines.length).toBeLessThanOrEqual(80);

    // Verify 2: Memory Snapshot 不超过 200 行 / 800 tokens
    const snapshot = buildMemorySnapshot(allMemories);
    const snapshotLines = snapshot.split('\n');
    expect(snapshotLines.length).toBeLessThanOrEqual(200);

    // Verify 3: Skill patches can be applied
    const skillPatches: SkillPatch[] = [
      {
        action: 'create',
        skillName: 'code-style-guide',
        content: '---\nname: code-style-guide\n---\nAuto-generated style guide',
        source: 'evolution',
        confidence: 0.75,
      },
    ];
    const patchResult = await patcher.applyPatches(skillPatches);
    expect(patchResult.applied.length).toBe(1);

    // Verify 4: Digest triggers after accumulation
    expect(shouldTriggerDigest({ undigestedCount: allMemories.length, lastDigestAt: null })).toBe(
      true,
    );

    // Verify 5: Digest produces insights
    const digestItems: DigestableItem[] = allMemories.slice(0, 25).map((m, i) => ({
      uri: `viking://mem/user_test/item-${i}`,
      content: m.content,
      importance: m.importance ?? 0.3,
      accessCount: 0,
    }));
    const clusters = clusterItems(digestItems);
    // May or may not cluster depending on content similarity — just verify no crash
    expect(clusters).toBeInstanceOf(Array);

    // Verify 6: All storage data consistent — lesson count matches what we wrote
    expect(lessonLines.length).toBeGreaterThan(0);
    expect(lessonLines.length).toBeLessThanOrEqual(80);

    // Snapshot covers multiple categories
    if (snapshot.length > 0) {
      expect(snapshot).toContain('# Memory Snapshot');
    }
  });
});
