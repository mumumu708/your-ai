/**
 * YourBot 飞书集成 MCP Server
 *
 * Provides tools for Feishu (Lark) platform operations:
 * - feishu_send_message: Send messages to users or groups
 * - feishu_read_doc: Read Feishu cloud documents
 * - feishu_search: Search across Feishu resources
 * - feishu_get_calendar: Query calendar events
 *
 * This server is started by Claude Code via .mcp.json configuration.
 * Authentication is handled via environment variables set during workspace init.
 */

import { McpServerBase } from '../shared/mcp-server-base';
import { createAuthMiddleware } from '../shared/auth-middleware';

const server = new McpServerBase({
  name: 'feishu-server',
  version: '1.0.0',
  description: 'YourBot 飞书集成工具集',
});

const auth = createAuthMiddleware();

// --- Tools ---

server.tool(
  'feishu_send_message',
  '向指定的飞书用户或群组发送消息',
  {
    target: { type: 'string', description: '目标用户 open_id 或群组 chat_id' },
    targetType: { type: 'string', enum: ['user', 'group'], description: '目标类型' },
    messageType: { type: 'string', enum: ['text', 'interactive', 'markdown'], description: '消息类型' },
    content: { type: 'string', description: '消息内容' },
  },
  async (input) => {
    const { target, targetType, messageType, content } = input as {
      target: string; targetType: string; messageType?: string; content: string;
    };

    // TODO: Integrate with actual Feishu API client
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          messageId: `msg_${Date.now()}`,
          target,
          targetType,
          messageType: messageType ?? 'text',
          contentLength: content.length,
          sentBy: auth.getContext().userId,
        }),
      }],
    };
  },
);

server.tool(
  'feishu_read_doc',
  '读取飞书云文档的内容',
  {
    docToken: { type: 'string', description: '文档 token（从 URL 中提取）' },
    docType: { type: 'string', enum: ['docx', 'wiki', 'sheet'], description: '文档类型' },
  },
  async (input) => {
    const { docToken, docType } = input as { docToken: string; docType?: string };

    // TODO: Integrate with actual Feishu API client
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          docToken,
          docType: docType ?? 'docx',
          content: `[Document content placeholder for ${docToken}]`,
        }),
      }],
    };
  },
);

server.tool(
  'feishu_search',
  '在飞书中搜索消息、文档或人员',
  {
    query: { type: 'string', description: '搜索关键词' },
    scope: { type: 'string', enum: ['message', 'doc', 'people'], description: '搜索范围' },
    limit: { type: 'number', description: '返回结果数量上限' },
  },
  async (input) => {
    const { query, scope, limit } = input as { query: string; scope?: string; limit?: number };

    // TODO: Integrate with actual Feishu API client
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          query,
          scope: scope ?? 'message',
          results: [],
          total: 0,
          limit: limit ?? 10,
        }),
      }],
    };
  },
);

server.tool(
  'feishu_get_calendar',
  '查询飞书日历事件',
  {
    startDate: { type: 'string', description: '开始日期 (ISO 8601)' },
    endDate: { type: 'string', description: '结束日期 (ISO 8601)' },
  },
  async (input) => {
    const { startDate, endDate } = input as { startDate: string; endDate: string };

    // TODO: Integrate with actual Feishu API client
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          startDate,
          endDate,
          events: [],
        }),
      }],
    };
  },
);

// Start server
server.run();
