import type { Database } from 'bun:sqlite';
import { Logger } from '../../shared/logging/logger';
import type { TaskRecord } from '../../shared/tasking/task.types';

export class TaskStore {
  private readonly logger = new Logger('TaskStore');

  constructor(private readonly db: Database) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'sync',
        source TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'pending',
        description TEXT,
        inbound_message_id TEXT,
        claude_session_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        result_summary TEXT,
        error_message TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(status) WHERE status IN ('pending', 'running');
      CREATE INDEX IF NOT EXISTS idx_tasks_inbound_msg ON tasks(inbound_message_id) WHERE inbound_message_id IS NOT NULL;
    `);
  }

  create(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, user_id, session_id, type, execution_mode, source,
                           status, description, inbound_message_id, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.userId,
        task.sessionId,
        task.type,
        task.executionMode,
        task.source,
        task.description ?? null,
        task.inboundMessageId ?? null,
        task.createdAt,
        task.metadata ? JSON.stringify(task.metadata) : null,
      );
    this.logger.debug('Task created', { taskId: task.id, type: task.type });
  }

  updateStatus(
    taskId: string,
    status: TaskRecord['status'],
    fields?: Partial<
      Pick<
        TaskRecord,
        'startedAt' | 'completedAt' | 'resultSummary' | 'errorMessage' | 'claudeSessionId'
      >
    >,
  ): void {
    const sets = ['status = ?'];
    const values: (string | number)[] = [status];

    if (fields?.startedAt != null) {
      sets.push('started_at = ?');
      values.push(fields.startedAt);
    }
    if (fields?.completedAt != null) {
      sets.push('completed_at = ?');
      values.push(fields.completedAt);
    }
    if (fields?.resultSummary != null) {
      sets.push('result_summary = ?');
      values.push(fields.resultSummary);
    }
    if (fields?.errorMessage != null) {
      sets.push('error_message = ?');
      values.push(fields.errorMessage);
    }
    if (fields?.claudeSessionId != null) {
      sets.push('claude_session_id = ?');
      values.push(fields.claudeSessionId);
    }

    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getHistory(userId: string, limit = 20): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
       WHERE user_id = ? AND execution_mode != 'sync'
       ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapTaskRow);
  }

  getActiveBySession(sessionId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
       WHERE session_id = ? AND status IN ('pending', 'running')
       ORDER BY created_at`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(mapTaskRow);
  }

  findByMessageId(messageId: string): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE inbound_message_id = ? AND status IN ('pending', 'running')`,
      )
      .get(messageId) as Record<string, unknown> | null;
    return row ? mapTaskRow(row) : undefined;
  }

  markInterruptedOnStartup(): number {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', error_message = 'process_restart',
                         completed_at = ?
       WHERE status = 'running'`,
      )
      .run(Date.now());
    if (result.changes > 0) {
      this.logger.info('Marked interrupted tasks', { count: result.changes });
    }
    return result.changes;
  }

  cleanupOld(daysToKeep = 30): number {
    const cutoff = Date.now() - daysToKeep * 86400_000;
    const result = this.db
      .prepare(`DELETE FROM tasks WHERE completed_at < ? AND status NOT IN ('pending', 'running')`)
      .run(cutoff);
    if (result.changes > 0) {
      this.logger.info('Cleaned up old tasks', { count: result.changes });
    }
    return result.changes;
  }
}

// ── Row mapper (snake_case -> camelCase) ──

function mapTaskRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sessionId: row.session_id as string,
    type: row.type as string,
    executionMode: row.execution_mode as TaskRecord['executionMode'],
    source: row.source as TaskRecord['source'],
    status: row.status as TaskRecord['status'],
    description: (row.description as string) ?? undefined,
    inboundMessageId: (row.inbound_message_id as string) ?? undefined,
    claudeSessionId: (row.claude_session_id as string) ?? undefined,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number) ?? undefined,
    completedAt: (row.completed_at as number) ?? undefined,
    resultSummary: (row.result_summary as string) ?? undefined,
    errorMessage: (row.error_message as string) ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
      : undefined,
  };
}
