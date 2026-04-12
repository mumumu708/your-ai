import type { Database } from 'bun:sqlite';
import { Logger } from '../../shared/logging/logger';
import type { MessageRecord, SearchResult, SessionRecord } from '../../shared/tasking/task.types';

const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 5000;

export class SessionStore {
  private readonly logger = new Logger('SessionStore');
  private writeQueue: MessageRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly db: Database) {
    this.initSchema();
    this.markInterruptedOnStartup();
  }

  private initSchema(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA cache_size = -64000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT,
        message_count INTEGER DEFAULT 0,
        summary TEXT,
        reflection_processed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_time ON sessions(user_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_reflection ON sessions(user_id, reflection_processed, ended_at);

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        token_estimate INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_user_time ON session_messages(user_id, timestamp DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        content,
        content=session_messages,
        content_rowid=id,
        tokenize='unicode61'
      );
    `);

    // Triggers must be created separately (FTS virtual table references)
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_insert AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_messages_fts_delete BEFORE DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.id, old.content);
      END;
    `);
  }

  // ── Session lifecycle ──

  createSession(record: Omit<SessionRecord, 'messageCount' | 'reflectionProcessed'>): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, channel, conversation_id, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.userId,
        record.channel,
        record.conversationId ?? null,
        record.startedAt,
      );
    this.logger.debug('Session created', { sessionId: record.id });
  }

  closeSession(sessionId: string, reason: string, summary?: string): void {
    this.flushWriteQueue();
    this.db
      .prepare(
        `UPDATE sessions
       SET ended_at = ?, end_reason = ?, summary = ?,
           message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?)
       WHERE id = ?`,
      )
      .run(Date.now(), reason, summary ?? null, sessionId, sessionId);
    this.logger.debug('Session closed', { sessionId, reason });
  }

  markReflectionProcessed(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET reflection_processed = 1 WHERE id = ?').run(sessionId);
  }

  // ── Message write queue (batched) ──

  appendMessage(message: MessageRecord): void {
    this.writeQueue.push(message);

    if (this.writeQueue.length >= BATCH_SIZE) {
      this.flushWriteQueue();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushWriteQueue(), FLUSH_INTERVAL_MS);
    }
  }

  flushWriteQueue(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.writeQueue.length === 0) return;

    const batch = this.writeQueue.splice(0);
    const insert = this.db.prepare(
      `INSERT INTO session_messages (session_id, user_id, role, content, timestamp, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((messages: MessageRecord[]) => {
      for (const m of messages) {
        insert.run(m.sessionId, m.userId, m.role, m.content, m.timestamp, m.tokenEstimate ?? null);
      }
    });
    tx(batch);
    this.logger.debug('Flushed messages', { count: batch.length });
  }

  // ── Queries ──

  searchMessages(params: {
    userId: string;
    query: string;
    limit?: number;
  }): SearchResult[] {
    const limit = params.limit ?? 10;
    return this.db
      .prepare(
        `SELECT
        m.session_id as sessionId,
        m.role,
        m.content,
        m.timestamp,
        s.channel,
        s.summary as sessionSummary,
        highlight(session_messages_fts, 0, '<mark>', '</mark>') as highlight
      FROM session_messages_fts fts
      JOIN session_messages m ON fts.rowid = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE fts.content MATCH ?
        AND m.user_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ?`,
      )
      .all(params.query, params.userId, limit) as SearchResult[];
  }

  getRecentSessions(params: {
    userId: string;
    days?: number;
    limit?: number;
  }): SessionRecord[] {
    const since = Date.now() - (params.days ?? 7) * 86400_000;
    const limit = params.limit ?? 10;
    const rows = this.db
      .prepare(
        `SELECT id, user_id, channel, conversation_id, started_at, ended_at,
              end_reason, message_count, summary, reflection_processed
       FROM sessions
       WHERE user_id = ? AND started_at > ?
       ORDER BY started_at DESC
       LIMIT ?`,
      )
      .all(params.userId, since, limit) as Array<Record<string, unknown>>;
    return rows.map(mapSessionRow);
  }

  getSessionMessages(sessionId: string, limit?: number): MessageRecord[] {
    if (limit) {
      const rows = this.db
        .prepare(
          `SELECT id, session_id, user_id, role, content, timestamp, token_estimate
           FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`,
        )
        .all(sessionId, limit) as Array<Record<string, unknown>>;
      return rows.map(mapMessageRow);
    }
    const rows = this.db
      .prepare(
        `SELECT id, session_id, user_id, role, content, timestamp, token_estimate
         FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(mapMessageRow);
  }

  getUnreflectedSessions(userId: string, limit?: number): SessionRecord[] {
    if (limit) {
      const rows = this.db
        .prepare(
          `SELECT id, user_id, channel, conversation_id, started_at, ended_at,
                end_reason, message_count, summary, reflection_processed
           FROM sessions
           WHERE user_id = ? AND reflection_processed = 0 AND ended_at IS NOT NULL
           ORDER BY ended_at ASC LIMIT ?`,
        )
        .all(userId, limit) as Array<Record<string, unknown>>;
      return rows.map(mapSessionRow);
    }
    const rows = this.db
      .prepare(
        `SELECT id, user_id, channel, conversation_id, started_at, ended_at,
              end_reason, message_count, summary, reflection_processed
         FROM sessions
         WHERE user_id = ? AND reflection_processed = 0 AND ended_at IS NOT NULL
         ORDER BY ended_at ASC`,
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(mapSessionRow);
  }

  // ── Lifecycle ──

  markInterruptedOnStartup(): void {
    const result = this.db
      .prepare(
        `UPDATE sessions SET ended_at = ?, end_reason = 'process_restart'
       WHERE ended_at IS NULL`,
      )
      .run(Date.now());
    if (result.changes > 0) {
      this.logger.info('Marked interrupted sessions', { count: result.changes });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushWriteQueue();
  }
}

// ── Row mappers (snake_case -> camelCase) ──

function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    channel: row.channel as string,
    conversationId: (row.conversation_id as string) ?? undefined,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number) ?? undefined,
    endReason: (row.end_reason as string) ?? undefined,
    messageCount: (row.message_count as number) ?? 0,
    summary: (row.summary as string) ?? undefined,
    reflectionProcessed: row.reflection_processed === 1,
  };
}

function mapMessageRow(row: Record<string, unknown>): MessageRecord {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    userId: row.user_id as string,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    timestamp: row.timestamp as number,
    tokenEstimate: (row.token_estimate as number) ?? undefined,
  };
}
