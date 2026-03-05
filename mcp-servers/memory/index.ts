/**
 * YourBot 用户记忆系统 MCP Server
 *
 * Provides tools for user memory management backed by OpenViking:
 * - memory_store: Store information via ov.write() to VikingFS
 * - memory_retrieve: Read a memory via ov.read()
 * - memory_search: Semantic search via ov.find()
 * - memory_delete: Delete a memory via ov.rm()
 */

import { McpServerBase } from '../shared/mcp-server-base';
import { createAuthMiddleware } from '../shared/auth-middleware';
import { OpenVikingClient } from '../../src/kernel/memory/openviking/openviking-client';

const server = new McpServerBase({
  name: 'memory-server',
  version: '2.0.0',
  description: 'YourBot 用户记忆存取系统 (OpenViking)',
});

const auth = createAuthMiddleware();
const ovUrl = process.env.OPENVIKING_URL ?? 'http://localhost:1933';
const ov = new OpenVikingClient({ baseUrl: ovUrl });

const CATEGORY_URI_MAP: Record<string, string> = {
  preference: 'viking://user/memories/preferences',
  fact: 'viking://user/memories/facts',
  context: 'viking://user/memories/episodic',
  instruction: 'viking://user/memories/procedures',
};

server.tool(
  'memory_store',
  '将重要信息存储到用户的长期记忆中，以便在后续对话中检索使用',
  {
    content: { type: 'string', description: '要存储的记忆内容' },
    category: {
      type: 'string',
      enum: ['preference', 'fact', 'context', 'instruction'],
      description: '记忆分类',
    },
    tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    importance: { type: 'string', enum: ['low', 'medium', 'high'], description: '重要性' },
  },
  async (input) => {
    const { content, category, tags, importance } = input as {
      content: string; category: string; tags?: string[]; importance?: string;
    };

    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const baseUri = CATEGORY_URI_MAP[category] ?? 'viking://user/memories/facts';
    const uri = `${baseUri}/${id}`;

    // Build metadata header
    const metadata = [
      `<!-- tags: ${(tags ?? []).join(',')} -->`,
      `<!-- importance: ${importance ?? 'medium'} -->`,
      `<!-- userId: ${auth.getContext().userId} -->`,
      '',
    ].join('\n');

    await ov.write(uri, metadata + content);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ success: true, memoryId: id, uri }),
      }],
    };
  },
);

server.tool(
  'memory_retrieve',
  '通过 URI 检索特定记忆',
  {
    memoryId: { type: 'string', description: '记忆 ID 或 URI' },
  },
  async (input) => {
    const { memoryId } = input as { memoryId: string };

    // Support both bare ID and full URI
    const uri = memoryId.startsWith('viking://')
      ? memoryId
      : `viking://user/memories/facts/${memoryId}`;

    try {
      const content = await ov.read(uri);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, uri, content }),
        }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Memory not found' }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_search',
  '通过语义相似度搜索用户的历史记忆',
  {
    query: { type: 'string', description: '搜索查询文本' },
    category: {
      type: 'string',
      enum: ['preference', 'fact', 'context', 'instruction'],
      description: '限定搜索分类',
    },
    limit: { type: 'number', description: '返回结果数量上限' },
  },
  async (input) => {
    const { query, category, limit } = input as {
      query: string; category?: string; limit?: number;
    };

    const targetUri = category
      ? (CATEGORY_URI_MAP[category] ?? 'viking://user/memories')
      : 'viking://user/memories';

    const results = await ov.find({
      query,
      target_uri: targetUri,
      limit: limit ?? 5,
    });

    const formatted = results.map((r) => ({
      uri: r.uri,
      abstract: r.abstract,
      score: r.score,
      match_reason: r.match_reason,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ results: formatted }),
      }],
    };
  },
);

server.tool(
  'memory_delete',
  '删除一条记忆',
  {
    memoryId: { type: 'string', description: '记忆 ID 或 URI' },
  },
  async (input) => {
    const { memoryId } = input as { memoryId: string };

    const uri = memoryId.startsWith('viking://')
      ? memoryId
      : `viking://user/memories/facts/${memoryId}`;

    try {
      await ov.rm(uri);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, deleted: uri }),
        }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Memory not found' }) }],
        isError: true,
      };
    }
  },
);

// Start server
server.run();
