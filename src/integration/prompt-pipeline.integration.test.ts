/**
 * 集成测试: Prompt 构建管道
 *
 * 测试完整的 prompt 组装流程:
 *   SystemPromptBuilder.build → memory-snapshot-builder → turn-context-builder → prepend-context-builder
 *
 * Mock: ConfigLoader (文件系统/OV), LLM
 * 验证: prompt 组装产出正确结构，包含 memory、context、system instructions
 */
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ConfigLoader } from '../kernel/prompt/config-loader';
import { type MemoryItem, buildMemorySnapshot } from '../kernel/prompt/memory-snapshot-builder';
import { buildPrependContext } from '../kernel/prompt/prepend-context-builder';
import { SYSTEM_PROMPT_BUDGET } from '../kernel/prompt/prompt-types';
import { SystemPromptBuilder } from '../kernel/prompt/system-prompt-builder';
import { buildTurnContext } from '../kernel/prompt/turn-context-builder';

// ── Test helpers ──────────────────────────────────────────

function createMockConfigLoader(overrides?: {
  identity?: string;
  soul?: string;
  agents?: string;
}): ConfigLoader {
  const files: Record<string, string> = {
    'IDENTITY.md': overrides?.identity ?? '# Identity\nI am TestBot, a helpful assistant.',
    'SOUL.md': overrides?.soul ?? '# Soul\nBe concise and helpful.',
    'AGENTS.md':
      overrides?.agents ??
      `# AGENTS
## Memory 交互协议
- 记住用户偏好
- 主动回忆相关上下文
## 工具使用规范
- 工具调用前确认
## 其他章节
- 不相关内容`,
    'USER.md': '# User Profile\nDeveloper who likes TypeScript.',
  };

  return {
    loadFile: mock(async (filename: string) => files[filename] ?? ''),
    loadAll: mock(async () => ({
      soul: files['SOUL.md'] ?? '',
      identity: files['IDENTITY.md'] ?? '',
      user: files['USER.md'] ?? '',
      agents: files['AGENTS.md'] ?? '',
    })),
    invalidateCache: mock(() => {}),
    getLessonsLearned: mock(async () => ''),
  } as unknown as ConfigLoader;
}

// ── Tests ─────────────────────────────────────────────────

describe('Prompt 构建管道集成测试', () => {
  let _logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    _logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── SystemPromptBuilder 端到端组装 ──────────────────────

  describe('SystemPromptBuilder 端到端组装', () => {
    test('应正确组装包含所有 section 的 frozen system prompt', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const memories: MemoryItem[] = [
        { content: '用户偏好 dark mode', category: 'preference' },
        { content: '项目使用 Bun 运行时', category: 'fact' },
      ];
      const memorySnapshot = buildMemorySnapshot(memories);
      const skillIndex = '# 可用 Skills\n- **deploy**: 部署到生产环境 [✅]';

      const result = await builder.build({
        userId: 'user_test',
        channel: 'web',
        skillIndex,
        memorySnapshot,
      });

      // 验证结构完整性
      expect(result.content).toContain('I am TestBot');
      expect(result.content).toContain('Be concise and helpful');
      expect(result.content).toContain('Memory 交互协议');
      expect(result.content).toContain('可用 Skills');
      expect(result.content).toContain('用户偏好 dark mode');
      expect(result.content).toContain('项目使用 Bun 运行时');
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.builtAt).toBeGreaterThan(0);
      expect(result.sections.identity).toBeTruthy();
      expect(result.sections.soul).toBeTruthy();
    });

    test('超出 token 预算时应自动裁剪低优先级 section', async () => {
      // 生成一个巨大的 AGENTS.md 让 prompt 超预算
      const hugeAgents = `# AGENTS\n## Memory 交互协议\n${'- 规则条目 '.repeat(3000)}`;
      const configLoader = createMockConfigLoader({ agents: hugeAgents });
      const builder = new SystemPromptBuilder(configLoader);

      const result = await builder.build({
        userId: 'user_test',
        channel: 'web',
      });

      // 裁剪后应不超过预算
      expect(result.totalTokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
      // identity 和 soul 是高优先级，应保留
      expect(result.sections.identity).toBeTruthy();
      expect(result.sections.soul).toBeTruthy();
    });

    test('空 memory 和 skillIndex 时应正常组装', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const result = await builder.build({
        userId: 'user_test',
        channel: 'feishu',
      });

      expect(result.content).toContain('I am TestBot');
      expect(result.content).toContain('通道：feishu');
      // 默认 skillIndex fallback
      expect(result.content).toContain('可用 Skills');
      expect(result.totalTokens).toBeGreaterThan(0);
    });
  });

  // ── TurnContext + Memory 注入 ──────────────────────────

  describe('TurnContext 构建与注入', () => {
    test('应将 retrieved memories 格式化为 memory-context 区块', () => {
      const now = Date.now();
      const result = buildTurnContext({
        memories: [
          { content: '用户喜欢 TypeScript', updatedAt: now - 86400000 },
          { content: '项目用 Bun', updatedAt: now },
        ],
        executionMode: 'sync',
        taskType: 'chat',
      });

      expect(result.content).toContain('<memory-context>');
      expect(result.content).toContain('用户喜欢 TypeScript');
      expect(result.content).toContain('项目用 Bun');
      expect(result.content).toContain('</memory-context>');
      expect(result.content).toContain('<task-guidance>');
      expect(result.content).toContain('同步执行模式');
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    test('post-compaction 场景应包含 invoked-skills 恢复提示', () => {
      const result = buildTurnContext({
        postCompaction: true,
        invokedSkills: ['deploy-staging', 'rss-digest'],
      });

      expect(result.content).toContain('<invoked-skills>');
      expect(result.content).toContain('deploy-staging');
      expect(result.content).toContain('rss-digest');
      expect(result.content).toContain('skill_view');
    });

    test('无任何输入时应返回空 content', () => {
      const result = buildTurnContext({});

      expect(result.content).toBe('');
      expect(result.totalTokens).toBe(0);
    });

    test('MCP delta 应显示新增和断开的 server', () => {
      const result = buildTurnContext({
        mcpServers: {
          current: ['filesystem', 'github'],
          previous: ['filesystem', 'slack'],
        },
      });

      expect(result.content).toContain('<mcp-delta>');
      expect(result.content).toContain('MCP server connected: github');
      expect(result.content).toContain('MCP server disconnected: slack');
    });
  });

  // ── PrependContext OVERRIDE 语义 ───────────────────────

  describe('PrependContext OVERRIDE 语义', () => {
    test('应生成包含 system-reminder 的 OVERRIDE 首轮注入', () => {
      const result = buildPrependContext({
        agentsConfig: '# 工具使用规范\n- 先确认再调用',
        userConfig: '# 用户档案\n- 偏好简洁回复',
      });

      expect(result).toContain('<system-reminder>');
      expect(result).toContain('</system-reminder>');
      expect(result).toContain('OVERRIDE');
      expect(result).toContain('工具使用规范');
      expect(result).toContain('用户档案');
      expect(result).toContain("Today's date is");
    });
  });

  // ── 端到端: 全管道串联 ────────────────────────────────

  describe('全管道串联', () => {
    test('SystemPrompt + TurnContext + PrependContext 应产出完整的三级结构', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      // L1: Frozen system prompt
      const memories: MemoryItem[] = [{ content: '用户是前端工程师', category: 'fact' }];
      const frozen = await builder.build({
        userId: 'user_e2e',
        channel: 'web',
        memorySnapshot: buildMemorySnapshot(memories),
      });

      // L2: Per-turn context
      const turnCtx = buildTurnContext({
        memories: [{ content: '上次讨论了 React 性能优化', updatedAt: Date.now() }],
        executionMode: 'sync',
        taskType: 'harness',
      });

      // L3: Prepend context (first message)
      const prepend = buildPrependContext({
        agentsConfig: '遵循工程规范',
        userConfig: '偏好 TypeScript',
      });

      // 验证三级结构各自完整且不互相干扰
      expect(frozen.content).toContain('用户是前端工程师');
      expect(frozen.content).not.toContain('上次讨论了 React');

      expect(turnCtx.content).toContain('上次讨论了 React');
      expect(turnCtx.content).toContain('工程任务');

      expect(prepend).toContain('system-reminder');
      expect(prepend).toContain('偏好 TypeScript');

      // Token 预算验证
      expect(frozen.totalTokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
      expect(turnCtx.totalTokens).toBeGreaterThan(0);
    });
  });
});
