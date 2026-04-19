import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { TaskRecord } from '../../shared/tasking/task.types';
import { TaskStore } from './task-store';

const BASE = Date.now();

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    userId: 'user_a',
    sessionId: 'sess_1',
    type: 'chat',
    executionMode: 'sync',
    source: 'user',
    status: 'pending',
    createdAt: BASE,
    ...overrides,
  };
}

describe('TaskStore', () => {
  let db: Database;
  let store: TaskStore;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    db = new Database(':memory:');
    store = new TaskStore(db);
  });

  afterEach(() => {
    db.close();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('schema initialization', () => {
    test('should create tasks table on construction', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain('tasks');
    });

    test('should create indexes', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tasks%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain('idx_tasks_session');
      expect(names).toContain('idx_tasks_user_status');
      expect(names).toContain('idx_tasks_active');
      expect(names).toContain('idx_tasks_inbound_msg');
    });
  });

  describe('create', () => {
    test('should insert a task with all fields', () => {
      const task = makeTask({
        description: 'Test task',
        inboundMessageId: 'msg_1',
        metadata: { key: 'value' },
      });
      store.create(task);

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<
        string,
        unknown
      >;
      expect(row.id).toBe(task.id);
      expect(row.user_id).toBe('user_a');
      expect(row.session_id).toBe('sess_1');
      expect(row.type).toBe('chat');
      expect(row.execution_mode).toBe('sync');
      expect(row.source).toBe('user');
      expect(row.status).toBe('pending');
      expect(row.description).toBe('Test task');
      expect(row.inbound_message_id).toBe('msg_1');
      expect(JSON.parse(row.metadata as string)).toEqual({ key: 'value' });
    });

    test('should insert a task with minimal fields', () => {
      const task = makeTask();
      store.create(task);

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<
        string,
        unknown
      >;
      expect(row.id).toBe(task.id);
      expect(row.description).toBeNull();
      expect(row.inbound_message_id).toBeNull();
      expect(row.metadata).toBeNull();
    });
  });

  describe('updateStatus', () => {
    test('should update status only', () => {
      const task = makeTask();
      store.create(task);
      store.updateStatus(task.id, 'running');

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe('running');
    });

    test('should update status with additional fields', () => {
      const task = makeTask();
      store.create(task);

      const now = Date.now();
      store.updateStatus(task.id, 'completed', {
        startedAt: now - 1000,
        completedAt: now,
        resultSummary: 'Done',
      });

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe('completed');
      expect(row.started_at).toBe(now - 1000);
      expect(row.completed_at).toBe(now);
      expect(row.result_summary).toBe('Done');
    });

    test('should update errorMessage', () => {
      const task = makeTask();
      store.create(task);
      store.updateStatus(task.id, 'failed', {
        completedAt: Date.now(),
        errorMessage: 'Something broke',
      });

      const row = db.prepare('SELECT error_message FROM tasks WHERE id = ?').get(task.id) as Record<
        string,
        unknown
      >;
      expect(row.error_message).toBe('Something broke');
    });

    test('should update claudeSessionId', () => {
      const task = makeTask();
      store.create(task);
      store.updateStatus(task.id, 'running', {
        startedAt: Date.now(),
        claudeSessionId: 'claude_123',
      });

      const row = db
        .prepare('SELECT claude_session_id FROM tasks WHERE id = ?')
        .get(task.id) as Record<string, unknown>;
      expect(row.claude_session_id).toBe('claude_123');
    });
  });

  describe('getHistory', () => {
    test('should return non-sync tasks ordered by created_at DESC', () => {
      store.create(makeTask({ id: 't1', executionMode: 'sync', createdAt: BASE }));
      store.create(makeTask({ id: 't2', executionMode: 'async', createdAt: BASE + 1 }));
      store.create(makeTask({ id: 't3', executionMode: 'long-horizon', createdAt: BASE + 2 }));

      const history = store.getHistory('user_a');
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('t3');
      expect(history[1].id).toBe('t2');
    });

    test('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        store.create(makeTask({ id: `th_${i}`, executionMode: 'async', createdAt: BASE + i }));
      }
      const history = store.getHistory('user_a', 2);
      expect(history).toHaveLength(2);
    });

    test('should filter by userId', () => {
      store.create(makeTask({ id: 't_a', userId: 'user_a', executionMode: 'async' }));
      store.create(makeTask({ id: 't_b', userId: 'user_b', executionMode: 'async' }));

      expect(store.getHistory('user_a')).toHaveLength(1);
      expect(store.getHistory('user_b')).toHaveLength(1);
    });
  });

  describe('getActiveBySession', () => {
    test('should return pending and running tasks for a session', () => {
      store.create(makeTask({ id: 't1', sessionId: 'sess_1', status: 'pending', createdAt: BASE }));
      store.create(
        makeTask({ id: 't2', sessionId: 'sess_1', status: 'pending', createdAt: BASE + 1 }),
      );
      // Update t2 to running
      store.updateStatus('t2', 'running', { startedAt: Date.now() });
      store.create(
        makeTask({ id: 't3', sessionId: 'sess_1', status: 'pending', createdAt: BASE + 2 }),
      );
      // Update t3 to completed
      store.updateStatus('t3', 'completed', { completedAt: Date.now() });

      const active = store.getActiveBySession('sess_1');
      expect(active).toHaveLength(2);
      expect(active[0].id).toBe('t1');
      expect(active[1].id).toBe('t2');
    });

    test('should not return tasks from other sessions', () => {
      store.create(makeTask({ id: 't1', sessionId: 'sess_1' }));
      store.create(makeTask({ id: 't2', sessionId: 'sess_2' }));

      const active = store.getActiveBySession('sess_1');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('t1');
    });
  });

  describe('findByMessageId', () => {
    test('should find pending task by inbound message ID', () => {
      store.create(makeTask({ id: 't1', inboundMessageId: 'msg_100' }));

      const found = store.findByMessageId('msg_100');
      expect(found).toBeDefined();
      expect(found?.id).toBe('t1');
    });

    test('should find running task by inbound message ID', () => {
      store.create(makeTask({ id: 't1', inboundMessageId: 'msg_101' }));
      store.updateStatus('t1', 'running', { startedAt: Date.now() });

      const found = store.findByMessageId('msg_101');
      expect(found).toBeDefined();
      expect(found?.status).toBe('running');
    });

    test('should not find completed task', () => {
      store.create(makeTask({ id: 't1', inboundMessageId: 'msg_102' }));
      store.updateStatus('t1', 'completed', { completedAt: Date.now() });

      expect(store.findByMessageId('msg_102')).toBeUndefined();
    });

    test('should return undefined for unknown message ID', () => {
      expect(store.findByMessageId('nonexistent')).toBeUndefined();
    });
  });

  describe('markInterruptedOnStartup', () => {
    test('should mark running tasks as failed with process_restart', () => {
      store.create(makeTask({ id: 't1' }));
      store.updateStatus('t1', 'running', { startedAt: Date.now() });
      store.create(makeTask({ id: 't2' }));
      store.updateStatus('t2', 'running', { startedAt: Date.now() });
      store.create(makeTask({ id: 't3' })); // pending — should not be affected

      const count = store.markInterruptedOnStartup();
      expect(count).toBe(2);

      const row1 = db
        .prepare('SELECT status, error_message, completed_at FROM tasks WHERE id = ?')
        .get('t1') as Record<string, unknown>;
      expect(row1.status).toBe('failed');
      expect(row1.error_message).toBe('process_restart');
      expect(row1.completed_at).toBeDefined();

      const row3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t3') as Record<
        string,
        unknown
      >;
      expect(row3.status).toBe('pending');
    });

    test('should return 0 when no running tasks', () => {
      store.create(makeTask({ id: 't1' })); // pending
      expect(store.markInterruptedOnStartup()).toBe(0);
    });
  });

  describe('cleanupOld', () => {
    test('should delete completed tasks older than cutoff', () => {
      const oldTime = Date.now() - 60 * 86400_000; // 60 days ago
      store.create(makeTask({ id: 't_old', createdAt: oldTime }));
      store.updateStatus('t_old', 'completed', { completedAt: oldTime + 1000 });

      store.create(makeTask({ id: 't_new', createdAt: BASE }));
      store.updateStatus('t_new', 'completed', { completedAt: BASE + 1000 });

      const deleted = store.cleanupOld(30);
      expect(deleted).toBe(1);

      expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get('t_old')).toBeNull();
      expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get('t_new')).not.toBeNull();
    });

    test('should not delete pending/running tasks even if old', () => {
      const oldTime = Date.now() - 60 * 86400_000;
      store.create(makeTask({ id: 't_pending', createdAt: oldTime }));
      store.create(makeTask({ id: 't_running', createdAt: oldTime }));
      store.updateStatus('t_running', 'running', { startedAt: oldTime });

      const deleted = store.cleanupOld(30);
      expect(deleted).toBe(0);
    });

    test('should accept custom daysToKeep', () => {
      const time = Date.now() - 10 * 86400_000; // 10 days ago
      store.create(makeTask({ id: 't1', createdAt: time }));
      store.updateStatus('t1', 'failed', { completedAt: time + 1000, errorMessage: 'err' });

      expect(store.cleanupOld(15)).toBe(0); // within 15 days
      expect(store.cleanupOld(5)).toBe(1); // outside 5 days
    });
  });

  describe('metadata serialization', () => {
    test('should round-trip metadata through JSON', () => {
      const task = makeTask({
        executionMode: 'async',
        metadata: { channel: 'feishu', nested: { a: 1 } },
      });
      store.create(task);

      const history = store.getHistory('user_a');
      expect(history[0].metadata).toEqual({ channel: 'feishu', nested: { a: 1 } });
    });

    test('should handle undefined metadata', () => {
      const task = makeTask({ executionMode: 'async' });
      store.create(task);

      const history = store.getHistory('user_a');
      expect(history[0].metadata).toBeUndefined();
    });
  });
});
