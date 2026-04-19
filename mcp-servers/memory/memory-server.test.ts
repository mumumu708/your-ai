import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAuthMiddleware } from '../shared/auth-middleware';
import { McpServerBase } from '../shared/mcp-server-base';

/**
 * Protocol-level smoke test for the memory MCP server.
 *
 * The real `index.ts` makes HTTP calls to OpenViking — to test that here
 * would require a fake HTTP server. Instead this test verifies the
 * McpServerBase protocol works correctly for the tools we register
 * (viking_search, viking_read, viking_browse, viking_remember,
 * viking_add_resource) using shape-compatible stubs.
 */
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
    const server = new McpServerBase({ name: 'memory-server', version: '3.0.0' });
    const auth = createAuthMiddleware();
    const remembered: Array<{ content: string; userId: string }> = [];
    const resources: Array<{ uri: string; content?: string; path?: string }> = [];

    server.tool(
      'viking_search',
      '语义检索',
      { query: { type: 'string' }, scope: { type: 'string' } },
      async (input) => {
        const { query } = input as { query: string };
        const hits = remembered
          .filter((m) => m.userId === auth.getContext().userId && m.content.includes(query))
          .map((m, i) => ({
            uri: `viking://user/default/memories/events/mem_${i}.md`,
            type: 'memory',
            score: 0.9,
            abstract: m.content,
          }));
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ results: hits, total: hits.length }) },
          ],
        };
      },
    );

    server.tool(
      'viking_read',
      '读取内容',
      { uri: { type: 'string' }, level: { type: 'string' } },
      async (input) => {
        const { uri } = input as { uri: string };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ uri, level: 'full', content: `mock content of ${uri}` }) },
          ],
        };
      },
    );

    server.tool(
      'viking_browse',
      '浏览',
      { action: { type: 'string' }, path: { type: 'string' } },
      async (input) => {
        const { action, path } = input as { action: string; path?: string };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ path: path ?? 'viking://', action, entries: [] }),
            },
          ],
        };
      },
    );

    server.tool(
      'viking_remember',
      '记住事实',
      { content: { type: 'string' }, category: { type: 'string' } },
      async (input) => {
        const { content } = input as { content: string };
        remembered.push({ content, userId: auth.getContext().userId });
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ status: 'remembered' }) },
          ],
        };
      },
    );

    server.tool(
      'viking_add_resource',
      '添加资源',
      {
        content: { type: 'string' },
        path: { type: 'string' },
        uri: { type: 'string' },
      },
      async (input) => {
        const { content, path, uri } = input as {
          content?: string;
          path?: string;
          uri?: string;
        };
        const storedUri = uri ?? `viking://resources/mock_${resources.length}.md`;
        resources.push({ uri: storedUri, content, path });
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ status: 'added', uri: storedUri }) },
          ],
        };
      },
    );

    return server;
  }

  test('注册5个 viking_* 工具', () => {
    const server = createMemoryServer();
    const tools = server.getToolDefinitions().map((t) => t.name);
    expect(tools).toContain('viking_search');
    expect(tools).toContain('viking_read');
    expect(tools).toContain('viking_browse');
    expect(tools).toContain('viking_remember');
    expect(tools).toContain('viking_add_resource');
    expect(tools.length).toBe(5);
  });

  test('viking_remember 应写入并可被 viking_search 检索', async () => {
    const server = createMemoryServer();

    const rememberResp = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'viking_remember',
        arguments: { content: '用户喜欢喝咖啡', category: 'preference' },
      },
    });
    const rememberData = JSON.parse(
      (rememberResp!.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(rememberData.status).toBe('remembered');

    const searchResp = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'viking_search', arguments: { query: '咖啡' } },
    });
    const searchData = JSON.parse(
      (searchResp!.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(searchData.results.length).toBe(1);
    expect(searchData.results[0].abstract).toContain('咖啡');
  });

  test('viking_add_resource 支持 content 和 uri 指定', async () => {
    const server = createMemoryServer();

    const resp = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'viking_add_resource',
        arguments: {
          content: '# 日历\n2025-01-01: 元旦',
          uri: 'viking://resources/user_001/calendar/2025-01.md',
        },
      },
    });
    const data = JSON.parse(
      (resp!.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(data.status).toBe('added');
    expect(data.uri).toBe('viking://resources/user_001/calendar/2025-01.md');
  });
});
