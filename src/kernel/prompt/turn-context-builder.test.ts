import { describe, expect, test } from 'bun:test';
import { estimateTokens } from './prompt-types';
import { buildTurnContext } from './turn-context-builder';

describe('buildTurnContext', () => {
  describe('memory context', () => {
    test('无记忆时不生成 memory-context section', () => {
      const result = buildTurnContext({});
      expect(result.content).not.toContain('<memory-context>');
    });

    test('空记忆数组不生成 memory-context section', () => {
      const result = buildTurnContext({ memories: [] });
      expect(result.content).not.toContain('<memory-context>');
    });

    test('有记忆时生成带日期的 memory-context section', () => {
      const result = buildTurnContext({
        memories: [
          { content: '用户偏好中文', updatedAt: new Date('2026-04-10').getTime() },
          { content: '使用 Bun 运行时', updatedAt: new Date('2026-04-11').getTime() },
        ],
      });

      expect(result.content).toContain('<memory-context>');
      expect(result.content).toContain('</memory-context>');
      expect(result.content).toContain('## 相关记忆');
      expect(result.content).toContain('[2026-04-10] 用户偏好中文');
      expect(result.content).toContain('[2026-04-11] 使用 Bun 运行时');
    });
  });

  describe('task guidance', () => {
    test('无任务信息时不生成 task-guidance section', () => {
      const result = buildTurnContext({});
      expect(result.content).not.toContain('<task-guidance>');
    });

    test('sync 模式生成对应提示', () => {
      const result = buildTurnContext({ executionMode: 'sync' });
      expect(result.content).toContain('<task-guidance>');
      expect(result.content).toContain('同步执行模式');
      expect(result.content).toContain('</task-guidance>');
    });

    test('async 模式生成对应提示', () => {
      const result = buildTurnContext({ executionMode: 'async' });
      expect(result.content).toContain('异步执行模式');
    });

    test('long-horizon 模式生成对应提示', () => {
      const result = buildTurnContext({ executionMode: 'long-horizon' });
      expect(result.content).toContain('长周期执行模式');
    });

    test('harness 任务类型生成对应提示', () => {
      const result = buildTurnContext({ taskType: 'harness' });
      expect(result.content).toContain('工程任务');
    });

    test('chat 任务类型生成对应提示', () => {
      const result = buildTurnContext({ taskType: 'chat' });
      expect(result.content).toContain('对话任务');
    });

    test('executionMode 和 taskType 同时存在', () => {
      const result = buildTurnContext({
        executionMode: 'sync',
        taskType: 'chat',
      });
      expect(result.content).toContain('同步执行模式');
      expect(result.content).toContain('对话任务');
    });

    test('未知 executionMode 不生成 guidance', () => {
      const result = buildTurnContext({ executionMode: 'unknown-mode' });
      expect(result.content).not.toContain('<task-guidance>');
    });
  });

  describe('invoked skills (post-compaction)', () => {
    test('非 postCompaction 不生成 invoked-skills section', () => {
      const result = buildTurnContext({
        invokedSkills: ['graphify'],
        postCompaction: false,
      });
      expect(result.content).not.toContain('<invoked-skills>');
    });

    test('postCompaction 但无 skills 不生成 section', () => {
      const result = buildTurnContext({
        invokedSkills: [],
        postCompaction: true,
      });
      expect(result.content).not.toContain('<invoked-skills>');
    });

    test('postCompaction + skills 生成恢复提示', () => {
      const result = buildTurnContext({
        invokedSkills: ['graphify', 'coding-review'],
        postCompaction: true,
      });

      expect(result.content).toContain('<invoked-skills>');
      expect(result.content).toContain('</invoked-skills>');
      expect(result.content).toContain('skill_view');
      expect(result.content).toContain('- graphify');
      expect(result.content).toContain('- coding-review');
    });
  });

  describe('MCP delta', () => {
    test('无 mcpServers 参数不生成 delta', () => {
      const result = buildTurnContext({});
      expect(result.content).not.toContain('<mcp-delta>');
    });

    test('无变更不生成 delta', () => {
      const result = buildTurnContext({
        mcpServers: {
          current: ['serena', 'github'],
          previous: ['serena', 'github'],
        },
      });
      expect(result.content).not.toContain('<mcp-delta>');
    });

    test('新增 server 生成 connected 消息', () => {
      const result = buildTurnContext({
        mcpServers: {
          current: ['serena', 'github'],
          previous: ['serena'],
        },
      });

      expect(result.content).toContain('<mcp-delta>');
      expect(result.content).toContain('MCP server connected: github');
      expect(result.content).toContain('</mcp-delta>');
    });

    test('移除 server 生成 disconnected 消息', () => {
      const result = buildTurnContext({
        mcpServers: {
          current: ['serena'],
          previous: ['serena', 'github'],
        },
      });

      expect(result.content).toContain('MCP server disconnected: github');
    });

    test('同时有新增和移除', () => {
      const result = buildTurnContext({
        mcpServers: {
          current: ['serena', 'slack'],
          previous: ['serena', 'github'],
        },
      });

      expect(result.content).toContain('MCP server connected: slack');
      expect(result.content).toContain('MCP server disconnected: github');
    });
  });

  describe('skill recommendation (DD-022)', () => {
    test('有推荐时生成 skill-recommendation section', () => {
      const result = buildTurnContext({
        skillRecommendations: [
          { name: 'debug-ts', description: 'TypeScript 调试技能' },
          { name: 'graphify', description: '知识图谱生成' },
        ],
      });

      expect(result.content).toContain('<skill-recommendation>');
      expect(result.content).toContain('/debug-ts');
      expect(result.content).toContain('/graphify');
      expect(result.content).toContain('</skill-recommendation>');
    });

    test('无推荐时不生成 section', () => {
      const result = buildTurnContext({ skillRecommendations: [] });
      expect(result.content).not.toContain('<skill-recommendation>');
    });

    test('描述超过 80 字符被截断', () => {
      const longDesc = '这是一段非常长的技能描述'.repeat(10);
      const result = buildTurnContext({
        skillRecommendations: [{ name: 'test', description: longDesc }],
      });
      // 每行描述应不超过 80 字符
      const descLine = result.content.split('\n').find((l) => l.includes('/test:'));
      const afterColon = descLine!.split(': ').slice(1).join(': ');
      expect(afterColon.length).toBeLessThanOrEqual(80);
    });
  });

  describe('digest available (DD-022)', () => {
    test('有洞察时生成 digest-available section', () => {
      const result = buildTurnContext({
        digestInsights: [
          { topic: 'Rust 所有权', preview: '关于借用和生命周期的碎片已聚类' },
          { topic: 'TypeScript 技巧', preview: '类型体操相关笔记汇总' },
        ],
      });

      expect(result.content).toContain('<digest-available>');
      expect(result.content).toContain('Rust 所有权');
      expect(result.content).toContain('TypeScript 技巧');
      expect(result.content).toContain('</digest-available>');
    });

    test('无洞察时不生成 section', () => {
      const result = buildTurnContext({ digestInsights: [] });
      expect(result.content).not.toContain('<digest-available>');
    });
  });

  describe('组合场景', () => {
    test('所有 section 同时存在', () => {
      const result = buildTurnContext({
        memories: [{ content: '记忆1', updatedAt: Date.now() }],
        executionMode: 'sync',
        taskType: 'chat',
        invokedSkills: ['graphify'],
        postCompaction: true,
        mcpServers: {
          current: ['serena', 'new-server'],
          previous: ['serena'],
        },
      });

      expect(result.content).toContain('<memory-context>');
      expect(result.content).toContain('<task-guidance>');
      expect(result.content).toContain('<invoked-skills>');
      expect(result.content).toContain('<mcp-delta>');
      expect(result.totalTokens).toBe(estimateTokens(result.content));
    });

    test('全部为空时返回空 content', () => {
      const result = buildTurnContext({});
      expect(result.content).toBe('');
      expect(result.totalTokens).toBe(0);
    });

    test('totalTokens 与 content 一致', () => {
      const result = buildTurnContext({
        memories: [{ content: '测试记忆', updatedAt: Date.now() }],
        executionMode: 'async',
      });
      expect(result.totalTokens).toBe(estimateTokens(result.content));
    });
  });
});
