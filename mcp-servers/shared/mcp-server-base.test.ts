import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { McpServerBase } from './mcp-server-base';

describe('McpServerBase', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test('应该注册工具并列出', () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });
    server.tool('my_tool', 'A test tool', { input: { type: 'string' } }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    const tools = server.getToolDefinitions();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('my_tool');
  });

  test('handleRequest initialize 应该返回 server info', async () => {
    const server = new McpServerBase({ name: 'test-server', version: '2.0.0' });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    expect(response).not.toBeNull();
    const result = response!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('test-server');
    expect(serverInfo.version).toBe('2.0.0');
  });

  test('handleRequest notifications/initialized 应该返回 null', async () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response).toBeNull();
  });

  test('handleRequest tools/list 应该列出所有工具', async () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });
    server.tool('tool_a', 'Tool A', { x: { type: 'number' } }, async () => ({
      content: [{ type: 'text', text: 'a' }],
    }));
    server.tool('tool_b', 'Tool B', {}, async () => ({
      content: [{ type: 'text', text: 'b' }],
    }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response!.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBe(2);
    expect(result.tools[0].name).toBe('tool_a');
    expect(result.tools[1].name).toBe('tool_b');
  });

  test('handleRequest tools/call 应该执行工具', async () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });
    server.tool('greet', 'Greet user', { name: { type: 'string' } }, async (input) => ({
      content: [{ type: 'text', text: `Hello ${input.name}` }],
    }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'World' } },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe('Hello World');
  });

  test('handleRequest tools/call 未知工具应该返回错误', async () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });

    const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  test('handleRequest tools/call 执行错误应该返回错误', async () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });
    server.tool('fail', 'Fails', {}, async () => {
      throw new Error('handler error');
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'fail', arguments: {} },
    });

    const result = response!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('handler error');
  });

  test('handleRequest 未知方法应该返回 method not found', async () => {
    const server = new McpServerBase({ name: 'test', version: '1.0.0' });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'unknown/method',
    });

    expect(response!.error).toBeDefined();
    expect(response!.error!.code).toBe(-32601);
  });
});
