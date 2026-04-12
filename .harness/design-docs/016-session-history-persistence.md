# DD-016: Session 历史持久化（SQLite FTS）

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-11
- **上游**: [DD-011](011-architecture-upgrade-v2.md)
- **下游**: [DD-012](012-memory-reflection-upgrade.md)（后台反思依赖 session 历史）、[DD-013](013-task-scheduling-upgrade.md)（任务聚合需要上下文）

## 背景

当前 session 历史只存在于内存中（`Session.messages: ConversationMessage[]`）。会话关闭后，消息数据随 Session 对象销毁。`SessionMemoryExtractor` 在关闭时提取摘要存入 OpenViking，但原始消息丢失。

这导致三个能力缺失：

1. **跨会话检索不可能**：用户问"上周我们讨论过什么"无法回答
2. **后台反思无数据源**：DD-012 的反思 agent 需要读取近期 session 的完整历史
3. **MEMORY.md 整合无素材**：/dream 模式的 Gather 阶段需要从历史中搜集新信息

项目已有 SQLite 基础设施（Drizzle ORM，`infra/database/`），但当前只用于已废弃的 memory 表。

## 目标

1. 所有 session 消息持久化到 SQLite
2. FTS5 全文索引支持跨会话关键词检索
3. Session 元数据持久化（时间、通道、摘要、消息数、反思状态）
4. 通过 MCP tool `session_search` 暴露给 Claude Code
5. 写入不阻塞主链路（异步批量写入）

## 非目标

- 不替代 OpenViking（OpenViking 存语义记忆，SQLite 存原始历史）
- 不做消息编辑/删除（只追加）
- 不存工具调用的完整输入输出（只存用户和 assistant 的文本消息）
- 不做跨用户检索

## 方案

### 1. Schema 设计

```sql
-- Session 元数据
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                    -- session UUID
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,                  -- 'feishu' | 'telegram' | 'web'
  conversation_id TEXT,                   -- 通道内的会话 ID
  started_at INTEGER NOT NULL,            -- Unix ms
  ended_at INTEGER,                       -- 关闭时设置
  end_reason TEXT,                        -- 'idle_timeout' | 'user_close' | 'compaction'
  message_count INTEGER DEFAULT 0,
  summary TEXT,                           -- 关闭时 LLM 生成的摘要
  reflection_processed INTEGER DEFAULT 0, -- 0=未处理, 1=已反思
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX idx_sessions_user_time ON sessions(user_id, started_at DESC);
CREATE INDEX idx_sessions_reflection ON sessions(user_id, reflection_processed, ended_at);

-- Session 消息
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,                     -- 'user' | 'assistant'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,             -- Unix ms
  token_estimate INTEGER,                 -- 粗估 token 数
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_messages_session ON session_messages(session_id, timestamp);
CREATE INDEX idx_messages_user_time ON session_messages(user_id, timestamp DESC);

-- FTS5 全文索引
CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  content,
  content=session_messages,
  content_rowid=id,
  tokenize='unicode61'                    -- 支持中文分词
);

-- 自动同步触发器
CREATE TRIGGER session_messages_fts_insert AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER session_messages_fts_delete BEFORE DELETE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES('delete', old.id, old.content);
END;
```

#### 与现有 Schema 的关系

`infra/database/schema.ts` 中已有 `memories` 和 `session_summaries` 表（标记为 deprecated）。新表独立于旧表，不做迁移。旧表后续可清理。

### 2. SessionStore 实现

```typescript
// src/kernel/memory/session-store.ts

interface SessionRecord {
  id: string;
  userId: string;
  channel: string;
  conversationId?: string;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  messageCount: number;
  summary?: string;
  reflectionProcessed: boolean;
}

interface MessageRecord {
  id?: number;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  tokenEstimate?: number;
}

class SessionStore {
  private db: Database;              // better-sqlite3
  private writeQueue: MessageRecord[] = [];
  private flushTimer: Timer | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');     // 并发读写
    this.db.pragma('synchronous = NORMAL');   // 写入性能
    this.db.pragma('cache_size = -64000');    // 64MB cache
    this.initSchema();
  }

  // ── Session 生命周期 ──

  createSession(session: Omit<SessionRecord, 'messageCount' | 'reflectionProcessed'>): void {
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, channel, conversation_id, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, session.userId, session.channel,
           session.conversationId, session.startedAt);
  }

  closeSession(sessionId: string, reason: string, summary?: string): void {
    this.flushWriteQueue();  // 确保所有消息已写入
    this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, end_reason = ?, summary = ?,
          message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?)
      WHERE id = ?
    `).run(Date.now(), reason, summary, sessionId, sessionId);
  }

  markReflectionProcessed(sessionId: string): void {
    this.db.prepare(`
      UPDATE sessions SET reflection_processed = 1 WHERE id = ?
    `).run(sessionId);
  }

  // ── 消息写入（异步批量） ──

  appendMessage(message: MessageRecord): void {
    this.writeQueue.push(message);

    // 批量写入：积累 20 条或 5 秒超时
    if (this.writeQueue.length >= 20) {
      this.flushWriteQueue();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushWriteQueue(), 5000);
    }
  }

  private flushWriteQueue(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.writeQueue.length === 0) return;

    const batch = this.writeQueue.splice(0);
    const insert = this.db.prepare(`
      INSERT INTO session_messages (session_id, user_id, role, content, timestamp, token_estimate)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((messages: MessageRecord[]) => {
      for (const m of messages) {
        insert.run(m.sessionId, m.userId, m.role, m.content, m.timestamp, m.tokenEstimate);
      }
    });
    tx(batch);
  }

  // ── 检索 ──

  searchMessages(params: {
    userId: string;
    query: string;
    limit?: number;
  }): SearchResult[] {
    const limit = params.limit || 10;
    return this.db.prepare(`
      SELECT
        m.session_id,
        m.role,
        m.content,
        m.timestamp,
        s.channel,
        s.summary as session_summary,
        highlight(session_messages_fts, 0, '<mark>', '</mark>') as highlight
      FROM session_messages_fts fts
      JOIN session_messages m ON fts.rowid = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE fts.content MATCH ?
        AND m.user_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(params.query, params.userId, limit) as SearchResult[];
  }

  getRecentSessions(params: {
    userId: string;
    days?: number;
    limit?: number;
  }): SessionRecord[] {
    const since = Date.now() - (params.days || 7) * 86400_000;
    const limit = params.limit || 10;
    return this.db.prepare(`
      SELECT * FROM sessions
      WHERE user_id = ? AND started_at > ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(params.userId, since, limit) as SessionRecord[];
  }

  getSessionMessages(sessionId: string, limit?: number): MessageRecord[] {
    return this.db.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
      ${limit ? `LIMIT ${limit}` : ''}
    `).all(sessionId) as MessageRecord[];
  }

  // 后台反思用：获取未处理的 session
  getUnreflectedSessions(userId: string, limit?: number): SessionRecord[] {
    return this.db.prepare(`
      SELECT * FROM sessions
      WHERE user_id = ? AND reflection_processed = 0 AND ended_at IS NOT NULL
      ORDER BY ended_at ASC
      ${limit ? `LIMIT ${limit}` : ''}
    `).all(userId) as SessionRecord[];
  }

  // ── 生命周期 ──

  close(): void {
    this.flushWriteQueue();
    this.db.close();
  }
}
```

### 3. 集成到 SessionManager

```typescript
// src/kernel/sessioning/session-manager.ts 变更

class SessionManager {
  private sessionStore: SessionStore;

  resolveSession(userId, channel, conversationId): Session {
    const session = /* existing logic */;

    if (session.isNew) {
      // 持久化 session 元数据
      this.sessionStore.createSession({
        id: session.id,
        userId,
        channel,
        conversationId,
        startedAt: session.createdAt,
      });
    }

    return session;
  }

  addMessageToSession(sessionKey: string, message: ConversationMessage): void {
    /* existing: add to in-memory session.messages */

    // 新增：异步持久化
    this.sessionStore.appendMessage({
      sessionId: this.sessions.get(sessionKey)!.id,
      userId: this.sessions.get(sessionKey)!.userId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      tokenEstimate: Math.ceil(message.content.length / 4),
    });
  }

  closeSession(sessionKey: string, reason: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    // 生成摘要（复用已有 SessionMemoryExtractor）
    const summary = await this.extractSummary(session);

    // 持久化关闭
    this.sessionStore.closeSession(session.id, reason, summary);

    /* existing: cleanup in-memory session */
  }
}
```

### 4. session_search MCP Tool

```typescript
// mcp-servers/memory/index.ts 扩展

const sessionSearchTool = {
  name: 'session_search',
  description: '搜索历史会话。支持关键词搜索和近期会话列表。',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['keyword_search', 'recent'],
        description: 'keyword_search: 跨会话关键词搜索; recent: 近期会话列表',
      },
      query: {
        type: 'string',
        description: '搜索关键词（keyword_search 时必填）',
      },
      days: {
        type: 'number',
        description: '时间范围（天，默认 7）',
      },
      limit: {
        type: 'number',
        description: '最大返回数（默认 10）',
      },
    },
    required: ['operation'],
  },
  handler: async (args, context) => {
    const userId = context.userId;

    if (args.operation === 'keyword_search') {
      if (!args.query) return { error: 'query is required for keyword_search' };

      const results = sessionStore.searchMessages({
        userId,
        query: args.query,
        limit: args.limit,
      });

      // 按 session 聚合
      const grouped = groupBySession(results);
      return {
        matches: grouped.map(g => ({
          sessionId: g.sessionId,
          sessionSummary: g.sessionSummary,
          channel: g.channel,
          matchCount: g.messages.length,
          excerpts: g.messages.slice(0, 3).map(m => ({
            role: m.role,
            highlight: m.highlight,
            timestamp: formatTime(m.timestamp),
          })),
        })),
      };
    }

    if (args.operation === 'recent') {
      const sessions = sessionStore.getRecentSessions({
        userId,
        days: args.days,
        limit: args.limit,
      });

      return {
        sessions: sessions.map(s => ({
          id: s.id,
          channel: s.channel,
          startedAt: formatTime(s.startedAt),
          endedAt: s.endedAt ? formatTime(s.endedAt) : 'active',
          messageCount: s.messageCount,
          summary: s.summary,
        })),
      };
    }
  },
};
```

### 5. 数据保留策略

| 数据 | 保留期 | 清理方式 |
|------|--------|---------|
| Session 元数据 | 永久 | 不清理（数据量小） |
| 消息内容 | 90 天 | 定时任务删除旧消息，FTS 索引同步清理 |
| FTS 索引 | 随消息 | 触发器自动同步 |

```sql
-- 定时清理（通过 Scheduler 注册）
DELETE FROM session_messages WHERE timestamp < ? AND session_id IN (
  SELECT id FROM sessions WHERE user_id = ?
);
```

### 6. 并发安全

- **WAL 模式**：支持一写多读，写入不阻塞读取
- **批量写入**：20 条消息或 5 秒超时触发一次事务，减少 IO
- **应用级重试**：写入失败时 20-150ms 随机抖动后重试（最多 3 次）
- **关闭保证**：`SessionStore.close()` 先 flush 队列再关闭连接

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/memory/session-store.ts` | 新增 — SessionStore 完整实现 |
| `src/kernel/sessioning/session-manager.ts` | 修改 — 集成 SessionStore 写入 |
| `mcp-servers/memory/index.ts` | 扩展 — session_search tool |
| `infra/database/migrations/` | 新增 — session 表和 FTS 索引的 migration |
| `src/kernel/central-controller.ts` | 修改 — 初始化 SessionStore 并注入依赖 |

## 验收标准

- [ ] Session 创建/关闭时元数据持久化
- [ ] 每轮消息异步写入 SQLite（不阻塞主链路）
- [ ] FTS5 关键词搜索返回正确的匹配和高亮
- [ ] `session_search` MCP tool 可被 Claude Code 调用
- [ ] WAL 模式下并发读写无报错
- [ ] 消息保留策略可配置
- [ ] `bun run check:all` 通过

## 参考

- hermes-agent `hermes_state.py` — SQLite + FTS5 + WAL 模式
- hermes-agent `tools/session_search_tool.py` — 两阶段搜索（keyword → summarize）
- SQLite FTS5 文档 — unicode61 tokenizer 支持中文
