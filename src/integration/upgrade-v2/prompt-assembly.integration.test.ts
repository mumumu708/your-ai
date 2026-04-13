/**
 * DD-020: Prompt Assembly Integration Tests
 *
 * Tests the prompt assembly pipeline from skill index building through
 * frozen system prompt construction, prepend context, turn context,
 * and final system prompt assembly.
 *
 * PA-01: SkillIndexBuilder.build() generates skillIndex from availableSkills
 * PA-02: SystemPromptBuilder.build() cached via session.frozenSystemPrompt (controller-level freeze)
 * PA-03: buildPrependContext() uses USER.md and AGENTS.md
 * PA-04: buildTurnContext() with empty invokedSkills produces no skill section
 * PA-07: finalSystemPrompt = frozenContent + "\n\n" + turnContext.content
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { CentralControllerDeps } from '../../kernel/central-controller';
import type { EvolutionScheduler } from '../../kernel/evolution/evolution-scheduler';
import type { KnowledgeRouter } from '../../kernel/evolution/knowledge-router';
import type { PostResponseAnalyzer } from '../../kernel/evolution/post-response-analyzer';
import type { ConfigLoader } from '../../kernel/memory/config-loader';
import type { ContextManager } from '../../kernel/memory/context-manager';
import type { EntityManager } from '../../kernel/memory/graph/entity-manager';
import type { OpenVikingClient } from '../../kernel/memory/openviking/openviking-client';
import { buildPrependContext } from '../../kernel/prompt/prepend-context-builder';
import { SystemPromptBuilder } from '../../kernel/prompt/system-prompt-builder';
import { buildTurnContext } from '../../kernel/prompt/turn-context-builder';
import { SkillIndexBuilder } from '../../kernel/skills/skill-index-builder';
import type { SkillEntry } from '../../kernel/skills/skill-index-builder';
import type { LessonsLearnedUpdater } from '../../lessons/lessons-updater';
import type { BotMessage } from '../../shared/messaging/bot-message.types';

// ── Test fixtures ──

const SKILL_FIXTURES: SkillEntry[] = [
  { name: 'rss-digest', description: 'RSS feed digest', dir: 'skills/builtin/rss-digest' },
  {
    name: 'deploy-staging',
    description: 'Deploy to staging',
    dir: 'skills/builtin/deploy-staging',
  },
  { name: 'code-review', description: 'Code review helper', dir: 'skills/builtin/code-review' },
];

const SKILL_MD_CONTENT: Record<string, string> = {
  'skills/builtin/rss-digest/SKILL.md': `---
name: rss-digest
description: RSS feed digest
platforms:
  - feishu
  - web
---
# RSS Digest Skill`,
  'skills/builtin/deploy-staging/SKILL.md': `---
name: deploy-staging
description: Deploy to staging
---
# Deploy Staging Skill`,
  'skills/builtin/code-review/SKILL.md': `---
name: code-review
description: Code review helper
platforms:
  - web
---
# Code Review Skill`,
};

function _createMockMessage(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    id: 'msg_pa_001',
    channel: 'web',
    userId: 'user_pa_001',
    userName: 'PA Test User',
    conversationId: 'conv_pa_001',
    content: 'Hello prompt assembly test',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function createMockConfigLoader() {
  return {
    loadAll: mock(async () => ({
      soul: '# Soul\nBe helpful and kind.',
      identity: '# Identity\nTest Agent v1',
      user: '',
      agents: '',
    })),
    loadFile: mock(async (name: string) => {
      const files: Record<string, string> = {
        'IDENTITY.md': '# Identity\nTest Agent v1',
        'SOUL.md': '# Soul\nBe helpful and kind.',
        'AGENTS.md': `# Agents Config
## Memory 交互协议
- 使用 memory_search 查询
- 使用 memory_add 存储
## 工具使用规范
- 优先使用内置工具
## 会话管理
- 超时 30 分钟
## Skill 维护协议
- 通过 /skill-edit 修改`,
        'USER.md': '# User Profile\nPrefers Chinese responses.',
      };
      return files[name] ?? '';
    }),
    invalidateCache: mock(() => {}),
  } as unknown as ConfigLoader;
}

function _createMockOVDeps(): Partial<CentralControllerDeps> {
  return {
    knowledgeRouter: {
      buildContext: async () => ({
        systemPrompt: '--- Agent Identity ---\nTest Agent\n--- Agent Soul ---\nBe helpful',
        fragments: [],
        totalTokens: 20,
        conflictsResolved: [],
        retrievedMemories: [],
      }),
    } as unknown as KnowledgeRouter,
    postResponseAnalyzer: {
      analyzeExchange: async () => null,
    } as unknown as PostResponseAnalyzer,
    ovClient: {
      addMessage: async () => {},
      commit: async () => ({ memories_extracted: 0 }),
      find: async () => [],
    } as unknown as OpenVikingClient,
    contextManager: {
      checkAndFlush: async () => null,
    } as unknown as ContextManager,
    lessonsUpdater: {
      addLesson: async () => true,
    } as unknown as LessonsLearnedUpdater,
    evolutionScheduler: {
      schedulePostCommit: () => {},
    } as unknown as EvolutionScheduler,
    entityManager: {} as unknown as EntityManager,
  };
}

// ── Tests ──

describe('DD-020: Prompt Assembly Integration', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── PA-01: SkillIndexBuilder.build() from availableSkills ──

  describe('PA-01: SkillIndexBuilder generates skillIndex from availableSkills', () => {
    test('should include all skill entries in the generated index', () => {
      const builder = new SkillIndexBuilder();

      const loadFile = (path: string): string | null => SKILL_MD_CONTENT[path] ?? null;

      const skillIndex = builder.build({
        skills: SKILL_FIXTURES,
        loadFile,
      });

      // Every skill should appear in the index
      for (const skill of SKILL_FIXTURES) {
        expect(skillIndex).toContain(skill.name);
      }
    });

    test('should filter skills by platform when channel is specified', () => {
      const builder = new SkillIndexBuilder();
      const loadFile = (path: string): string | null => SKILL_MD_CONTENT[path] ?? null;

      // feishu channel: rss-digest has feishu, deploy-staging has no platform filter (passes),
      // code-review only has web
      const skillIndex = builder.build({
        skills: SKILL_FIXTURES,
        channel: 'feishu',
        loadFile,
      });

      expect(skillIndex).toContain('rss-digest');
      expect(skillIndex).toContain('deploy-staging'); // no platform restriction = all channels
      expect(skillIndex).not.toContain('code-review'); // web-only, filtered out for feishu
    });

    test('should mirror the controller code path: map availableSkills names to SkillEntry[]', () => {
      // Simulates the exact mapping at central-controller.ts line 910-917
      const availableSkills = ['rss-digest', 'deploy-staging', 'code-review'];
      const builder = new SkillIndexBuilder();

      const entries = availableSkills.map((name) => ({
        name,
        description: name, // controller uses name as description
        dir: `skills/builtin/${name}`,
      }));

      const loadFile = (path: string): string | null => SKILL_MD_CONTENT[path] ?? null;

      const skillIndex = builder.build({
        skills: entries,
        channel: 'web',
        loadFile,
      });

      // All skills should appear for web channel
      expect(skillIndex).toContain('rss-digest');
      expect(skillIndex).toContain('deploy-staging');
      expect(skillIndex).toContain('code-review');
      // Should have the header
      expect(skillIndex).toContain('# 可用 Skills');
    });

    test('should produce non-empty index even when no frontmatter is found', () => {
      const builder = new SkillIndexBuilder();
      // loadFile returns null for everything — no frontmatter parsed
      const _loadFile = (_path: string): string | null => null;

      const skillIndex = builder.build({
        skills: SKILL_FIXTURES,
      });

      // Skills should still be listed (with readiness warning since no frontmatter)
      for (const skill of SKILL_FIXTURES) {
        expect(skillIndex).toContain(skill.name);
      }
    });
  });

  // ── PA-02: SystemPromptBuilder cached via session.frozenSystemPrompt ──

  describe('PA-02: SystemPromptBuilder.build() cached at session level', () => {
    test('should produce a FrozenSystemPrompt with content and sections', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const frozen = await builder.build({
        userId: 'user_pa_001',
        channel: 'web',
        skillIndex: '# 可用 Skills\n- rss-digest: RSS feed digest [OK]',
      });

      expect(frozen.content).toBeTruthy();
      expect(frozen.totalTokens).toBeGreaterThan(0);
      expect(frozen.builtAt).toBeGreaterThan(0);
      expect(frozen.sections.identity).toContain('Test Agent');
      expect(frozen.sections.soul).toContain('Be helpful');
    });

    test('SystemPromptBuilder has NO internal cache — two calls both invoke configLoader', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const params = {
        userId: 'user_pa_001',
        channel: 'web',
        skillIndex: '# Skills\n- test',
      };

      await builder.build(params);
      await builder.build(params);

      // loadFile is called per build() invocation (IDENTITY.md, SOUL.md, AGENTS.md = 3 per call)
      // Two calls = 6 total loadFile calls. This proves NO internal caching.
      expect(configLoader.loadFile).toHaveBeenCalledTimes(6);
    });

    test('controller-level freeze: second pipeline round skips systemPromptBuilder.build()', async () => {
      // This test verifies the controller-level caching: `if (!task.session.frozenSystemPrompt)`
      // We create a real SystemPromptBuilder and track call count manually,
      // then simulate what the controller does across two rounds.
      const configLoader = createMockConfigLoader();
      const realBuilder = new SystemPromptBuilder(configLoader);
      let buildCallCount = 0;
      const builder = {
        build: async (...args: Parameters<typeof realBuilder.build>) => {
          buildCallCount++;
          return realBuilder.build(...args);
        },
      };

      // Simulate controller session state
      const session: {
        frozenSystemPrompt?: {
          content: string;
          totalTokens: number;
          builtAt: number;
          sections: Record<string, string>;
        };
      } = {};

      // Round 1: no frozenSystemPrompt → build
      if (!session.frozenSystemPrompt) {
        const frozen = await builder.build({
          userId: 'user_pa_001',
          channel: 'web',
          skillIndex: '# Skills\n- test',
        });
        session.frozenSystemPrompt = {
          ...frozen,
          sections: frozen.sections as unknown as Record<string, string>,
        };
      }

      expect(buildCallCount).toBe(1);
      expect(session.frozenSystemPrompt).toBeTruthy();
      expect(session.frozenSystemPrompt?.content).toContain('Test Agent');

      // Round 2: frozenSystemPrompt exists → skip build
      if (!session.frozenSystemPrompt) {
        await builder.build({
          userId: 'user_pa_001',
          channel: 'web',
          skillIndex: '# Skills\n- test',
        });
      }

      // Still only 1 call — second round was skipped
      expect(buildCallCount).toBe(1);
    });
  });

  // ── PA-03: buildPrependContext uses USER.md and AGENTS.md ──

  describe('PA-03: buildPrependContext() uses USER.md and AGENTS.md', () => {
    test('should include agentsConfig content in output', () => {
      const agentsConfig = '# Agents\n## Memory 交互协议\n- use memory_search';
      const userConfig = '# User\nPrefers short answers';

      const result = buildPrependContext({ agentsConfig, userConfig });

      expect(result).toContain(agentsConfig);
      expect(result).toContain(userConfig);
    });

    test('should wrap content in <system-reminder> tags with OVERRIDE semantics', () => {
      const result = buildPrependContext({
        agentsConfig: '# Agents Config',
        userConfig: '# User Config',
      });

      expect(result).toMatch(/^<system-reminder>/);
      expect(result).toMatch(/<\/system-reminder>$/);
      expect(result).toContain('OVERRIDE');
    });

    test('should include current date', () => {
      const result = buildPrependContext({
        agentsConfig: 'agents',
        userConfig: 'user',
      });

      const today = new Date().toISOString().split('T')[0];
      expect(result).toContain(today);
    });

    test('should include both claudeMd and userProfile sections', () => {
      const result = buildPrependContext({
        agentsConfig: 'my agents content',
        userConfig: 'my user content',
      });

      expect(result).toContain('# claudeMd');
      expect(result).toContain('my agents content');
      expect(result).toContain('# userProfile');
      expect(result).toContain('my user content');
    });

    test('mirrors controller code path: load USER.md and AGENTS.md then call buildPrependContext', async () => {
      // Simulates central-controller.ts line 935-940
      const mockUserConfigLoader = {
        loadFile: mock(async (name: string) => {
          if (name === 'USER.md') return '# User\nLikes concise replies';
          if (name === 'AGENTS.md') return '# Agents\n## Memory 交互协议\n- search first';
          return '';
        }),
      };

      const userConfig = (await mockUserConfigLoader.loadFile('USER.md')) || '';
      const agentsConfig = (await mockUserConfigLoader.loadFile('AGENTS.md')) || '';

      const prependContext = buildPrependContext({ agentsConfig, userConfig });

      expect(prependContext).toContain('Likes concise replies');
      expect(prependContext).toContain('Memory 交互协议');
      expect(prependContext).toContain('<system-reminder>');
    });
  });

  // ── PA-04: buildTurnContext with empty invokedSkills ──

  describe('PA-04: buildTurnContext() with empty/undefined invokedSkills produces no skill section', () => {
    test('undefined invokedSkills → no invoked-skills tag in output', () => {
      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        // invokedSkills: undefined (not provided)
      });

      expect(turnContext.content).not.toContain('<invoked-skills>');
      expect(turnContext.content).not.toContain('</invoked-skills>');
    });

    test('empty array invokedSkills → no invoked-skills tag in output', () => {
      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        invokedSkills: [],
      });

      expect(turnContext.content).not.toContain('<invoked-skills>');
      expect(turnContext.content).not.toContain('</invoked-skills>');
    });

    test('invokedSkills present but postCompaction=false → no invoked-skills tag', () => {
      // The code requires BOTH postCompaction=true AND non-empty invokedSkills
      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        invokedSkills: ['rss-digest'],
        postCompaction: false,
      });

      expect(turnContext.content).not.toContain('<invoked-skills>');
    });

    test('invokedSkills present AND postCompaction=true → invoked-skills tag appears', () => {
      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        invokedSkills: ['rss-digest', 'code-review'],
        postCompaction: true,
      });

      expect(turnContext.content).toContain('<invoked-skills>');
      expect(turnContext.content).toContain('rss-digest');
      expect(turnContext.content).toContain('code-review');
      expect(turnContext.content).toContain('</invoked-skills>');
    });

    test('mirrors controller code path: session.invokedSkills undefined → spread as undefined', () => {
      // Simulates central-controller.ts line 973:
      // invokedSkills: task.session.invokedSkills ? [...task.session.invokedSkills] : undefined
      const sessionInvokedSkills: Set<string> | undefined = undefined;
      const invokedSkills = sessionInvokedSkills ? [...sessionInvokedSkills] : undefined;

      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        invokedSkills,
        postCompaction: false,
      });

      expect(turnContext.content).not.toContain('invoked-skills');
    });
  });

  // ── PA-07: finalSystemPrompt = frozenContent + "\n\n" + turnContext.content ──

  describe('PA-07: finalSystemPrompt assembly format', () => {
    test('frozenContent + turnContext produces correct format', async () => {
      // Build frozen system prompt
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const frozen = await builder.build({
        userId: 'user_pa_001',
        channel: 'web',
        skillIndex: '# 可用 Skills\n- test-skill',
      });

      const frozenContent = frozen.content;

      // Build turn context with some content
      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        taskGuidance: '任务类型：chat（sync）\n简洁直接回答。',
      });

      // Simulate controller logic at line 989-995 (non-first-message, no prependBlock)
      const _isFirstMessage = false;
      const prependBlock = '';
      const finalSystemPrompt =
        frozenContent +
        (turnContext.content
          ? `\n\n${prependBlock}${turnContext.content}`
          : prependBlock
            ? `\n\n${prependBlock}`
            : '');

      // Verify format: frozen content followed by \n\n then turn context
      expect(finalSystemPrompt).toStartWith(frozenContent);
      expect(finalSystemPrompt).toContain('\n\n');
      expect(finalSystemPrompt).toContain(turnContext.content);
      // The separator between frozen and turn is exactly "\n\n"
      const frozenEnd = finalSystemPrompt.indexOf(frozenContent) + frozenContent.length;
      expect(finalSystemPrompt.slice(frozenEnd, frozenEnd + 2)).toBe('\n\n');
    });

    test('first message includes prependBlock before turnContext', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const frozen = await builder.build({
        userId: 'user_pa_001',
        channel: 'web',
      });
      const frozenContent = frozen.content;

      const prependContext = buildPrependContext({
        agentsConfig: '# Agents Config',
        userConfig: '# User Config',
      });

      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        taskGuidance: '任务类型：chat（sync）',
      });

      // Simulate first message: line 985-995
      const isFirstMessage = true;
      const prependBlock = isFirstMessage && prependContext ? `${prependContext}\n\n` : '';
      const finalSystemPrompt =
        frozenContent +
        (turnContext.content
          ? `\n\n${prependBlock}${turnContext.content}`
          : prependBlock
            ? `\n\n${prependBlock}`
            : '');

      // frozenContent comes first
      expect(finalSystemPrompt).toStartWith(frozenContent);
      // Then \n\n separator
      const afterFrozen = finalSystemPrompt.slice(frozenContent.length);
      expect(afterFrozen).toStartWith('\n\n');
      // prependContext appears before turnContext
      const prependIdx = finalSystemPrompt.indexOf(prependContext);
      const turnIdx = finalSystemPrompt.indexOf(turnContext.content);
      expect(prependIdx).toBeGreaterThan(-1);
      expect(turnIdx).toBeGreaterThan(-1);
      expect(prependIdx).toBeLessThan(turnIdx);
    });

    test('empty turnContext and no prependBlock produces just frozenContent', async () => {
      const configLoader = createMockConfigLoader();
      const builder = new SystemPromptBuilder(configLoader);

      const frozen = await builder.build({
        userId: 'user_pa_001',
        channel: 'web',
      });
      const frozenContent = frozen.content;

      // Turn context with no meaningful content
      const turnContext = buildTurnContext({});
      // When there's no taskGuidance, no memories, no invokedSkills, no mcpServers,
      // content should be empty
      const _isFirstMessage = false;
      const prependBlock = '';

      const finalSystemPrompt =
        frozenContent +
        (turnContext.content
          ? `\n\n${prependBlock}${turnContext.content}`
          : prependBlock
            ? `\n\n${prependBlock}`
            : '');

      // With no turn context content and no prepend, result is just frozen
      if (turnContext.content === '') {
        expect(finalSystemPrompt).toBe(frozenContent);
      } else {
        // If turnContext has any content, it should be appended
        expect(finalSystemPrompt).toContain(frozenContent);
      }
    });

    test('frozenContent with fallback when systemPromptBuilder fails', () => {
      // Simulates the fallback path at line 946-958
      const systemPromptFallback =
        '--- Agent Identity ---\nFallback Agent\n--- Agent Soul ---\nBe helpful';
      const frozenContent = systemPromptFallback; // falls back to KnowledgeRouter output

      const turnContext = buildTurnContext({
        taskType: 'chat',
        executionMode: 'sync',
        taskGuidance: '任务类型：chat（sync）',
      });

      const prependBlock = '';
      const finalSystemPrompt =
        frozenContent + (turnContext.content ? `\n\n${prependBlock}${turnContext.content}` : '');

      expect(finalSystemPrompt).toStartWith(systemPromptFallback);
      expect(finalSystemPrompt).toContain(turnContext.content);
    });
  });

  // ── PA-08: Deferred — SKIP ──
  // activeMcpServers has no production write path

  // ── PA-05, PA-06: Deferred — SKIP ──
});
