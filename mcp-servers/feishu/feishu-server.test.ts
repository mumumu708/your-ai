import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { McpServerBase } from '../shared/mcp-server-base';
import { createAuthMiddleware } from '../shared/auth-middleware';

describe('Feishu MCP Server', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.YOURBOT_USER_ID = 'user_001';
    process.env.YOURBOT_TENANT_ID = 'tenant_001';
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'test_secret';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createFeishuServer(): McpServerBase {
    const server = new McpServerBase({
      name: 'feishu-server',
      version: '1.0.0',
    });
    const auth = createAuthMiddleware();

    server.tool('feishu_send_message', '发送消息', {
      target: { type: 'string' },
      content: { type: 'string' },
    }, async (input) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({
        success: true,
        messageId: `msg_${Date.now()}`,
        sentBy: auth.getContext().userId,
      })}],
    }));

    server.tool('feishu_read_doc', '读取文档', {
      docToken: { type: 'string' },
    }, async (input) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({
        success: true,
        docToken: (input as Record<string, string>).docToken,
      })}],
    }));

    return server;
  }

  test('应该注册飞书相关工具', () => {
    const server = createFeishuServer();
    const tools = server.getToolDefinitions();
    expect(tools.map(t => t.name)).toContain('feishu_send_message');
    expect(tools.map(t => t.name)).toContain('feishu_read_doc');
  });

  test('feishu_send_message 应该返回成功结果', async () => {
    const server = createFeishuServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'feishu_send_message',
        arguments: { target: 'ou_xxx', content: 'hello' },
      },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.sentBy).toBe('user_001');
  });

  test('feishu_read_doc 应该返回文档内容', async () => {
    const server = createFeishuServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'feishu_read_doc',
        arguments: { docToken: 'doccnXYZ' },
      },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.docToken).toBe('doccnXYZ');
  });
});
