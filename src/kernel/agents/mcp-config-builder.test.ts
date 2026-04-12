import { describe, expect, test } from 'bun:test';
import { McpConfigBuilder } from './mcp-config-builder';

describe('McpConfigBuilder', () => {
  const builder = new McpConfigBuilder();

  describe('memory server', () => {
    test('始终包含 memory server', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'chat',
        userId: 'user-123',
      });

      const memory = config.mcpServers.find((s) => s.name === 'memory');
      expect(memory).toBeDefined();
      expect(memory?.env?.USER_ID).toBe('user-123');
    });
  });

  describe('skill server', () => {
    test('sync + chat → 不包含 skill server', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'chat',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'skill')).toBeUndefined();
    });

    test('async 模式 → 包含 skill server', () => {
      const config = builder.build({
        executionMode: 'async',
        taskType: 'chat',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'skill')).toBeDefined();
    });

    test('long-horizon 模式 → 包含 skill server', () => {
      const config = builder.build({
        executionMode: 'long-horizon',
        taskType: 'deep-research',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'skill')).toBeDefined();
    });

    test('sync + harness → 包含 skill server', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'harness',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'skill')).toBeDefined();
    });
  });

  describe('scheduler server', () => {
    test('普通任务 → 不包含 scheduler server', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'chat',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'scheduler')).toBeUndefined();
    });

    test('scheduled 任务 → 包含 scheduler server', () => {
      const config = builder.build({
        executionMode: 'async',
        taskType: 'scheduled',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'scheduler')).toBeDefined();
    });

    test('automation 任务 → 包含 scheduler server', () => {
      const config = builder.build({
        executionMode: 'async',
        taskType: 'automation',
        userId: 'user-1',
      });

      expect(config.mcpServers.find((s) => s.name === 'scheduler')).toBeDefined();
    });
  });

  describe('用户自定义 servers', () => {
    test('追加用户自定义 MCP 服务器', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'chat',
        userId: 'user-1',
        userMcpServers: [{ name: 'custom-tool', command: 'node', args: ['custom.js'] }],
      });

      const custom = config.mcpServers.find((s) => s.name === 'custom-tool');
      expect(custom).toBeDefined();
      expect(custom?.command).toBe('node');
      expect(custom?.args).toEqual(['custom.js']);
    });

    test('空数组不影响结果', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'chat',
        userId: 'user-1',
        userMcpServers: [],
      });

      // 只有 memory server
      expect(config.mcpServers.length).toBe(1);
    });
  });

  describe('组合场景', () => {
    test('scheduled + async + 用户自定义 → memory + skill + scheduler + custom', () => {
      const config = builder.build({
        executionMode: 'async',
        taskType: 'scheduled',
        userId: 'user-1',
        userMcpServers: [{ name: 'my-tool', command: 'bun', args: ['my-tool.ts'] }],
      });

      const names = config.mcpServers.map((s) => s.name);
      expect(names).toContain('memory');
      expect(names).toContain('skill');
      expect(names).toContain('scheduler');
      expect(names).toContain('my-tool');
      expect(config.mcpServers.length).toBe(4);
    });

    test('sync + chat → 仅 memory', () => {
      const config = builder.build({
        executionMode: 'sync',
        taskType: 'chat',
        userId: 'user-1',
      });

      expect(config.mcpServers.length).toBe(1);
      expect(config.mcpServers[0]?.name).toBe('memory');
    });
  });
});
