import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { McpServerBase } from '../shared/mcp-server-base';
import { createAuthMiddleware } from '../shared/auth-middleware';

describe('Memory MCP Server', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.YOURBOT_USER_ID = 'user_001';
    process.env.YOURBOT_TENANT_ID = 'tenant_001';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createMemoryServer(): McpServerBase {
    const server = new McpServerBase({ name: 'memory-server', version: '1.0.0' });
    const auth = createAuthMiddleware();
    const store = new Map<string, { id: string; content: string; userId: string }>();

    server.tool('memory_store', '存储记忆', {
      content: { type: 'string' },
      category: { type: 'string' },
    }, async (input) => {
      const { content, category } = input as { content: string; category: string };
      const id = `mem_test_${store.size}`;
      store.set(id, { id, content, userId: auth.getContext().userId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, memoryId: id }) }],
      };
    });

    server.tool('memory_search', '搜索记忆', {
      query: { type: 'string' },
    }, async (input) => {
      const { query } = input as { query: string };
      const userId = auth.getContext().userId;
      const results = Array.from(store.values())
        .filter(m => m.userId === userId && m.content.includes(query));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ results }) }],
      };
    });

    return server;
  }

  test('应该注册记忆相关工具', () => {
    const server = createMemoryServer();
    const tools = server.getToolDefinitions();
    expect(tools.map(t => t.name)).toContain('memory_store');
    expect(tools.map(t => t.name)).toContain('memory_search');
  });

  test('memory_store 应该存储记忆并返回 ID', async () => {
    const server = createMemoryServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_store',
        arguments: { content: '用户喜欢咖啡', category: 'preference' },
      },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.memoryId).toBeDefined();
  });

  test('memory_search 应该返回匹配结果', async () => {
    const server = createMemoryServer();

    // Store first
    await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'memory_store', arguments: { content: '喜欢喝咖啡', category: 'preference' } },
    });

    // Search
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: '咖啡' } },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.results.length).toBe(1);
    expect(data.results[0].content).toContain('咖啡');
  });
});
