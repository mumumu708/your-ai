/**
 * YourBot Memory MCP Server — Hermes-style bidirectional memory over OpenViking.
 *
 * Exposes 6 tools to the agent LLM:
 *   - viking_search       Semantic search across memories + resources (OV)
 *   - viking_read         Read content at viking:// URI (abstract/overview/full)
 *   - viking_browse       Filesystem-style navigation (list/tree/stat)
 *   - viking_remember     Store an important fact/preference long-term
 *   - viking_add_resource Add raw content / URL as a resource
 *   - session_search      Full-text search across past conversation history (SQLite FTS5)
 *
 * viking_search = semantic recall (OV embeddings)
 * session_search = keyword/exact match recall (SQLite FTS5 on raw conversation text)
 * Both are needed: OV for "what do I know about X?", FTS for "did user mention '1500元'?"
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { OpenVikingClient } from '../../src/kernel/memory/openviking/openviking-client';
import { SessionStore } from '../../src/kernel/memory/session-store';
import { createAuthMiddleware } from '../shared/auth-middleware';
import { McpServerBase } from '../shared/mcp-server-base';

const server = new McpServerBase({
  name: 'memory-server',
  version: '3.0.0',
  description: 'YourBot memory server — search/read/remember/add_resource via OpenViking',
});

const auth = createAuthMiddleware();
const ovUrl = process.env.OPENVIKING_URL ?? 'http://localhost:1933';
const ov = new OpenVikingClient({ baseUrl: ovUrl });

// ── viking_search ──────────────────────────────────────────

server.tool(
  'viking_search',
  '语义检索 OpenViking 中的知识（记忆、资源、技能）。返回按相关性排序的结果列表，每项含 uri、类型、分数、L0 摘要。' +
    '后续可用 viking_read(uri) 读取完整内容。用于回答涉及用户历史信息、偏好、事件的问题。',
  {
    query: { type: 'string', description: '搜索查询文本' },
    scope: {
      type: 'string',
      description:
        'Viking URI 前缀，用于限定搜索范围。常用：' +
        'viking://user/default/memories（用户记忆）、' +
        'viking://resources（用户上传的资源）、' +
        '省略则全库搜索',
    },
    limit: { type: 'number', description: '最大返回条数，默认 10' },
  },
  async (input) => {
    const { query, scope, limit } = input as {
      query: string;
      scope?: string;
      limit?: number;
    };

    if (!query) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'query is required' }) }],
        isError: true,
      };
    }

    const results = await ov.find({
      query,
      target_uri: scope,
      limit: limit ?? 10,
    });

    const formatted = results.map((r) => ({
      uri: r.uri,
      type: r.context_type,
      score: Number(r.score.toFixed(3)),
      abstract: r.abstract,
      match_reason: r.match_reason,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ results: formatted, total: formatted.length }, null, 2),
        },
      ],
    };
  },
);

// ── viking_read ────────────────────────────────────────────

server.tool(
  'viking_read',
  '读取指定 viking:// URI 的内容。三个详细等级：' +
    'abstract(~100 token，仅目录) / overview(~500-2000 token，仅目录) / full(完整内容，文件或目录)。' +
    '从 abstract 或 overview 开始，需要细节时再用 full。',
  {
    uri: {
      type: 'string',
      description: 'Viking URI，如 viking://user/default/memories/profile.md',
    },
    level: {
      type: 'string',
      enum: ['abstract', 'overview', 'full'],
      description: '详细等级，默认 full（最安全，对文件也适用）',
    },
  },
  async (input) => {
    const { uri, level } = input as {
      uri: string;
      level?: 'abstract' | 'overview' | 'full';
    };

    if (!uri) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'uri is required' }) }],
        isError: true,
      };
    }

    // abstract/overview only work on directories per OV docs.
    // Auto-fallback to read() if the URI is a file (has extension) or the call errors out.
    const lastSeg = uri.split('/').pop() ?? '';
    const isFile = lastSeg.includes('.');
    const effectiveLevel = level ?? 'full';

    let content = '';
    try {
      if (effectiveLevel === 'abstract' && !isFile) {
        content = await ov.abstract(uri);
      } else if (effectiveLevel === 'overview' && !isFile) {
        content = await ov.overview(uri);
      } else {
        content = await ov.read(uri);
      }
    } catch (err) {
      // Fallback: if the requested level fails (common for abstract on files),
      // try a plain read() before giving up.
      try {
        content = await ov.read(uri);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Failed to read ${uri}: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // Truncate extremely long content to protect agent context window
    if (content.length > 8000) {
      content = `${content.slice(0, 8000)}\n\n[... truncated. Use viking_read with a deeper URI for specifics.]`;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ uri, level: effectiveLevel, content }, null, 2),
        },
      ],
    };
  },
);

// ── viking_browse ──────────────────────────────────────────

server.tool(
  'viking_browse',
  '以文件系统风格浏览 OpenViking 知识库。list=列出目录内容，tree=层级树，stat=查看URI元数据。' +
    '起点推荐：viking://user/default/memories 或 viking://resources',
  {
    action: {
      type: 'string',
      enum: ['list', 'tree', 'stat'],
      description: '操作类型',
    },
    path: {
      type: 'string',
      description: 'Viking URI，默认 viking://',
    },
  },
  async (input) => {
    const { action, path } = input as { action: 'list' | 'tree' | 'stat'; path?: string };
    const target = path ?? 'viking://';

    try {
      if (action === 'tree') {
        const tree = await ov.tree(target, 3);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ path: target, tree }, null, 2) },
          ],
        };
      }
      if (action === 'stat') {
        const stat = await ov.stat(target);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ path: target, stat }, null, 2) },
          ],
        };
      }
      // list (default)
      const entries = await ov.ls(target);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ path: target, entries: entries.slice(0, 50) }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  },
);

// ── viking_remember ────────────────────────────────────────

server.tool(
  'viking_remember',
  '记录**单一、简短**的事实/偏好/事件到长期记忆（OpenViking 会自动分类、有损压缩成摘要）。' +
    '**严格限制：内容必须 < 200 字符、单一主题、无列表/表格/结构化数据**。' +
    '例：「用户生日是 1997-12-29」、「用户喜欢听德彪西」、「今天和王芳签了合同」。' +
    '🚨 如果内容包含以下任一特征，禁止用本工具，改用 viking_add_resource：' +
    '① 超过 200 字符；② 包含列表/表格/时间戳序列；③ 多个独立事实；④ 用户在"同步"/"导入"数据；' +
    '⑤ 原文细节（数字、日期、地点）需要精确保留。',
  {
    content: { type: 'string', description: '要记住的信息（简洁明确，一到三句话为佳）' },
    category: {
      type: 'string',
      enum: ['preference', 'entity', 'event', 'fact', 'procedure', 'pattern'],
      description: '可选分类提示',
    },
  },
  async (input) => {
    const { content, category } = input as { content: string; category?: string };

    if (!content) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'content is required' }) },
        ],
        isError: true,
      };
    }

    const userId = auth.getContext().userId;
    const labeled = category ? `[Remember — ${category}] ${content}` : `[Remember] ${content}`;

    try {
      // Ephemeral session: create → addMessage → commit → OV extracts memory.
      // MCP server has no access to the active agent session, so we create a
      // dedicated single-message session per remember call.
      const session = await ov.createSession({ userId, label: 'remember' });
      const sessionId = session.session_id ?? session.id;
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'OV createSession returned no session_id' }),
            },
          ],
          isError: true,
        };
      }
      await ov.addMessage(sessionId, 'user', labeled);
      await ov.commit(sessionId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'remembered',
              session_id: sessionId,
              message:
                'Memory queued for extraction. Searchable via viking_search after processing.',
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  },
);

// ── viking_add_resource ────────────────────────────────────

server.tool(
  'viking_add_resource',
  '将一个 URL（网页、GitHub repo、在线文档）导入到知识库。' +
    'OV 会自动解析、索引并生成摘要，之后可通过 viking_search 检索。' +
    '注意：此工具仅支持 URL，不支持直接传入文本内容。' +
    '用户在对话中发送的文本内容已由系统自动保存到 session 历史（可通过 session_search 检索）。',
  {
    url: { type: 'string', description: '要导入的 URL（网页、文档、仓库地址）' },
    reason: { type: 'string', description: '为什么导入此资源（有助于后续检索）' },
  },
  async (input) => {
    const { url, reason } = input as { url: string; reason?: string };

    if (!url) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'url is required' }) }],
        isError: true,
      };
    }

    try {
      const result = await ov.addResource({ path: url, reason });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'added',
              uri: result.uri ?? result.root_uri ?? '',
              message:
                'Resource queued for indexing. Searchable via viking_search after processing.',
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          },
        ],
        isError: true,
      };
    }
  },
);

// ── session_search ─────────────────────────────────────────

// Lazily connect to session SQLite DB (read-only, WAL allows concurrent reads).
// If the DB file doesn't exist yet, session_search gracefully returns empty results.
const sessionDbPath = process.env.SESSION_DB_PATH ?? 'data/session.db';
let sessionStore: SessionStore | null = null;
function getSessionStore(): SessionStore | null {
  if (sessionStore) return sessionStore;
  if (!existsSync(sessionDbPath)) return null;
  try {
    const db = new Database(sessionDbPath, { readonly: true });
    db.exec('PRAGMA journal_mode = WAL');
    sessionStore = new SessionStore(db);
    return sessionStore;
  } catch {
    return null;
  }
}

server.tool(
  'session_search',
  '在用户的**完整历史对话原文**中做关键词全文检索（SQLite FTS5）。' +
    '与 viking_search 互补：viking_search 用语义匹配检索 OV 中的记忆摘要，' +
    'session_search 用关键词精确匹配检索原始对话文本。' +
    '当需要找精确数字、日期、地名、人名等具体细节时，优先用 session_search。' +
    '支持两种操作：keyword（关键词搜索）和 recent（近期会话列表）。',
  {
    operation: {
      type: 'string',
      enum: ['keyword', 'recent'],
      description: 'keyword=关键词搜索, recent=近期会话列表',
    },
    query: {
      type: 'string',
      description: '搜索关键词（operation=keyword 时必填）',
    },
    days: {
      type: 'number',
      description: 'operation=recent 时的天数范围，默认 7',
    },
    limit: {
      type: 'number',
      description: '最大返回条数，默认 10',
    },
  },
  async (input) => {
    const { operation, query, days, limit } = input as {
      operation: 'keyword' | 'recent';
      query?: string;
      days?: number;
      limit?: number;
    };

    const store = getSessionStore();
    if (!store) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              results: [],
              message: 'Session database not available yet (no conversations recorded).',
            }),
          },
        ],
      };
    }

    const userId = auth.getContext().userId;

    if (operation === 'recent') {
      const sessions = store.getRecentSessions({
        userId,
        days: days ?? 7,
        limit: limit ?? 10,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                results: sessions.map((s) => ({
                  sessionId: s.id,
                  channel: s.channel,
                  startedAt: s.startedAt,
                  endedAt: s.endedAt,
                  messageCount: s.messageCount,
                  summary: s.summary,
                })),
                total: sessions.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // keyword search
    if (!query) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'query is required for keyword search' }),
          },
        ],
        isError: true,
      };
    }

    const results = store.searchMessages({
      userId,
      query,
      limit: limit ?? 10,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              results: results.map((r) => ({
                sessionId: r.sessionId,
                role: r.role,
                content: r.content.slice(0, 500),
                highlight: r.highlight,
                timestamp: r.timestamp,
                channel: r.channel,
                sessionSummary: r.sessionSummary,
              })),
              total: results.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Start server
server.run();
