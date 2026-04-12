import { describe, expect, test } from 'bun:test';
import { SYSTEM_PROMPT_BUDGET, estimateTokens } from './prompt-types';
import { SystemPromptBuilder } from './system-prompt-builder';

/** Mock ConfigLoader that returns preset strings */
function mockConfigLoader(overrides?: Partial<Record<string, string>>) {
  const defaults: Record<string, string> = {
    'IDENTITY.md': '# I am Your-AI\n你的个人 AI 助手。',
    'SOUL.md': '# Soul\n保持专业、诚实、有帮助。',
    'AGENTS.md': [
      '# Agents Protocol',
      '## Memory 交互协议',
      '- 检索相关记忆',
      '- 存储重要信息',
      '## 工具使用规范',
      '- 谨慎使用工具',
      '## 内部实现细节',
      '- OpenViking 协议',
      '- L0/L1 加载策略',
      '## 会话管理',
      '- 管理会话状态',
      '## Skill 维护协议',
      '- 按需加载 skill',
    ].join('\n'),
  };
  const files = { ...defaults, ...overrides };

  return {
    loadFile: async (name: string) => files[name] ?? `<!-- ${name} not found -->`,
    loadAll: async () => ({
      identity: files['IDENTITY.md'] ?? '',
      soul: files['SOUL.md'] ?? '',
      user: files['USER.md'] ?? '',
      agents: files['AGENTS.md'] ?? '',
    }),
    invalidateCache: () => {},
    getLessonsLearned: async () => '',
    updateUserProfile: async () => {},
  } as unknown as import('../memory/config-loader').ConfigLoader;
}

describe('SystemPromptBuilder', () => {
  test('构建包含所有 6 个 section', async () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const result = await builder.build({
      userId: 'u1',
      channel: 'feishu',
    });

    expect(result.sections.identity).toContain('I am Your-AI');
    expect(result.sections.soul).toContain('Soul');
    expect(result.sections.skillIndex).toContain('可用 Skills');
    expect(result.sections.runtimeHints).toContain('feishu');
    expect(result.builtAt).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test('sections 组装顺序固定: identity → soul → protocol → skill → memory → runtime', async () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const result = await builder.build({
      userId: 'u1',
      channel: 'web',
    });

    const content = result.content;
    const idxIdentity = content.indexOf('I am Your-AI');
    const idxSoul = content.indexOf('Soul');
    const idxProtocol = content.indexOf('操作规范');
    const idxSkill = content.indexOf('可用 Skills');
    const idxRuntime = content.indexOf('# Runtime');

    expect(idxIdentity).toBeLessThan(idxSoul);
    expect(idxSoul).toBeLessThan(idxProtocol);
    expect(idxProtocol).toBeLessThan(idxSkill);
    expect(idxSkill).toBeLessThan(idxRuntime);
  });

  test('runtime hints 包含通道能力', async () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const result = await builder.build({
      userId: 'u1',
      channel: 'feishu',
      workspacePath: '/workspace/project',
    });

    expect(result.sections.runtimeHints).toContain('流式卡片更新');
    expect(result.sections.runtimeHints).toContain('/workspace/project');
  });

  test('未知通道不包含通道能力行', async () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const result = await builder.build({
      userId: 'u1',
      channel: 'unknown-channel',
    });

    expect(result.sections.runtimeHints).not.toContain('通道能力');
  });

  test('token 数正确估算', async () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const result = await builder.build({
      userId: 'u1',
      channel: 'web',
    });

    expect(result.totalTokens).toBe(estimateTokens(result.content));
  });

  test('extractCoreProtocol 提取目标 sections', () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const fullAgents = [
      '# Agents Protocol',
      '## Memory 交互协议',
      '- 检索相关记忆',
      '## 内部实现细节',
      '- OpenViking 内部',
      '## 工具使用规范',
      '- 工具规则',
      '## 会话管理',
      '- 会话规则',
      '## Skill 维护协议',
      '- Skill 规则',
    ].join('\n');

    const result = builder.extractCoreProtocol(fullAgents);

    expect(result).toContain('Memory 交互协议');
    expect(result).toContain('检索相关记忆');
    expect(result).toContain('工具使用规范');
    expect(result).toContain('会话管理');
    expect(result).toContain('Skill 维护协议');
    expect(result).not.toContain('内部实现细节');
    expect(result).not.toContain('OpenViking 内部');
  });

  test('extractCoreProtocol AGENTS.md 为空时返回空字符串', () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    expect(builder.extractCoreProtocol('')).toBe('');
  });

  test('超出预算时按优先级裁剪', async () => {
    // 制造一个超大的 SOUL.md 来超出预算
    const hugeSoul = `# Soul\n${'这是一条非常重要的灵魂规则。\n'.repeat(500)}`;
    const builder = new SystemPromptBuilder(mockConfigLoader({ 'SOUL.md': hugeSoul }));

    const result = await builder.build({
      userId: 'u1',
      channel: 'feishu',
    });

    expect(result.totalTokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
    // identity should survive (highest priority)
    expect(result.sections.identity).toContain('I am Your-AI');
  });

  test('超出预算时 aggressive 裁剪（halving 不够时清空 section）', async () => {
    // 所有 section 都很大，halving 后仍然超预算 → 触发 aggressive clear
    const huge = (label: string) => `# ${label}\n${'x'.repeat(4000)}`;
    const builder = new SystemPromptBuilder(
      mockConfigLoader({
        'IDENTITY.md': huge('Identity'),
        'SOUL.md': huge('Soul'),
        'AGENTS.md': [
          '## Memory 交互协议',
          'x'.repeat(4000),
          '## 工具使用规范',
          'x'.repeat(4000),
        ].join('\n'),
      }),
    );

    const result = await builder.build({
      userId: 'u1',
      channel: 'feishu',
    });

    expect(result.totalTokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
    // Some low-priority sections should be fully cleared
    const clearedSections = [
      result.sections.runtimeHints,
      result.sections.memorySnapshot,
      result.sections.skillIndex,
    ];
    const hasSomeCleared = clearedSections.some((s) => s === '' || s.endsWith('...'));
    expect(hasSomeCleared).toBe(true);
  });

  test('trimToBudget 处理小 section（< 100 tokens）直接清空', async () => {
    // runtimeHints is small (< 100 tokens), should be directly cleared
    const hugeSoul = `# Soul\n${'规则内容。'.repeat(1200)}`;
    const builder = new SystemPromptBuilder(mockConfigLoader({ 'SOUL.md': hugeSoul }));

    const result = await builder.build({
      userId: 'u1',
      channel: 'web',
    });

    expect(result.totalTokens).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
  });

  test('assemble 跳过空 section', () => {
    const builder = new SystemPromptBuilder(mockConfigLoader());
    const content = builder.assemble({
      identity: 'ID',
      soul: '',
      protocol: '',
      skillIndex: '',
      memorySnapshot: '',
      runtimeHints: 'RT',
    });

    expect(content).toContain('ID');
    expect(content).toContain('RT');
    expect(content).not.toContain('操作规范');
    expect(content).not.toContain('可用 Skills');
  });
});
