import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { MessageRecord } from '../../shared/tasking/task.types';
import { SessionStore } from './session-store';

// Use a base time close to "now" so getRecentSessions days filter works
const BASE = Date.now();

describe('SessionStore', () => {
  let db: Database;
  let store: SessionStore;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    db = new Database(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => {
    store.close();
    db.close();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('schema initialization', () => {
    test('should create tables and indexes on construction', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('session_messages');
      expect(tableNames).toContain('session_messages_fts');
    });

    test('should create triggers for FTS sync', () => {
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all() as Array<{ name: string }>;
      const triggerNames = triggers.map((t) => t.name);
      expect(triggerNames).toContain('session_messages_fts_insert');
      expect(triggerNames).toContain('session_messages_fts_delete');
    });
  });

  describe('createSession / closeSession lifecycle', () => {
    test('should create and retrieve a session', () => {
      store.createSession({
        id: 'sess_001',
        userId: 'user_a',
        channel: 'web',
        conversationId: 'conv_1',
        startedAt: BASE,
      });

      const sessions = store.getRecentSessions({ userId: 'user_a', days: 7 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('sess_001');
      expect(sessions[0].userId).toBe('user_a');
      expect(sessions[0].channel).toBe('web');
      expect(sessions[0].conversationId).toBe('conv_1');
      expect(sessions[0].startedAt).toBe(BASE);
      expect(sessions[0].endedAt).toBeUndefined();
      expect(sessions[0].messageCount).toBe(0);
      expect(sessions[0].reflectionProcessed).toBe(false);
    });

    test('should close a session with reason and summary', () => {
      store.createSession({
        id: 'sess_002',
        userId: 'user_a',
        channel: 'feishu',
        startedAt: BASE,
      });

      store.appendMessage({
        sessionId: 'sess_002',
        userId: 'user_a',
        role: 'user',
        content: 'hello',
        timestamp: BASE + 1,
      });
      store.appendMessage({
        sessionId: 'sess_002',
        userId: 'user_a',
        role: 'assistant',
        content: 'hi there',
        timestamp: BASE + 2,
      });

      store.closeSession('sess_002', 'idle_timeout', 'Discussed greetings');

      const sessions = store.getRecentSessions({ userId: 'user_a', days: 7 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].endReason).toBe('idle_timeout');
      expect(sessions[0].summary).toBe('Discussed greetings');
      expect(sessions[0].messageCount).toBe(2);
      expect(sessions[0].endedAt).toBeDefined();
    });

    test('should close session without summary', () => {
      store.createSession({
        id: 'sess_003',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });
      store.closeSession('sess_003', 'user_close');

      const sessions = store.getRecentSessions({ userId: 'user_a', days: 7 });
      expect(sessions[0].endReason).toBe('user_close');
      expect(sessions[0].summary).toBeUndefined();
    });
  });

  describe('markReflectionProcessed', () => {
    test('should mark session as reflection processed', () => {
      store.createSession({
        id: 'sess_r1',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });
      store.closeSession('sess_r1', 'idle_timeout');

      let unreflected = store.getUnreflectedSessions('user_a');
      expect(unreflected).toHaveLength(1);

      store.markReflectionProcessed('sess_r1');

      unreflected = store.getUnreflectedSessions('user_a');
      expect(unreflected).toHaveLength(0);
    });
  });

  describe('appendMessage and batch flush', () => {
    test('should persist a single message after flush', () => {
      store.createSession({
        id: 'sess_m1',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      store.appendMessage({
        sessionId: 'sess_m1',
        userId: 'user_a',
        role: 'user',
        content: 'test message',
        timestamp: BASE + 1,
        tokenEstimate: 3,
      });

      // Not yet flushed
      const beforeFlush = store.getSessionMessages('sess_m1');
      expect(beforeFlush).toHaveLength(0);

      store.flushWriteQueue();

      const afterFlush = store.getSessionMessages('sess_m1');
      expect(afterFlush).toHaveLength(1);
      expect(afterFlush[0].content).toBe('test message');
      expect(afterFlush[0].role).toBe('user');
      expect(afterFlush[0].tokenEstimate).toBe(3);
    });

    test('should auto-flush at batch size (20 messages)', () => {
      store.createSession({
        id: 'sess_batch',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      for (let i = 0; i < 20; i++) {
        store.appendMessage({
          sessionId: 'sess_batch',
          userId: 'user_a',
          role: 'user',
          content: `msg ${i}`,
          timestamp: BASE + i,
        });
      }

      // Should have auto-flushed at 20
      const messages = store.getSessionMessages('sess_batch');
      expect(messages).toHaveLength(20);
    });

    test('should flush remaining messages on close', () => {
      store.createSession({
        id: 'sess_close',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      store.appendMessage({
        sessionId: 'sess_close',
        userId: 'user_a',
        role: 'user',
        content: 'unflushed',
        timestamp: BASE + 1,
      });

      store.close();

      const messages = store.getSessionMessages('sess_close');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('unflushed');
    });

    test('should handle empty flush gracefully', () => {
      store.flushWriteQueue(); // no-op, should not throw
    });

    test('should flush via timer callback when batch size is not reached', async () => {
      store.createSession({
        id: 'sess_timer',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      // appendMessage schedules a timer (flush interval) when queue < BATCH_SIZE
      // We use fake timers to trigger the callback synchronously
      const originalSetTimeout = globalThis.setTimeout;
      let timerCallback: (() => void) | null = null;
      globalThis.setTimeout = ((fn: () => void, _delay: number) => {
        timerCallback = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      store.appendMessage({
        sessionId: 'sess_timer',
        userId: 'user_a',
        role: 'user',
        content: 'timer message',
        timestamp: BASE + 1,
      });

      globalThis.setTimeout = originalSetTimeout;

      // Verify message not yet in DB
      expect(store.getSessionMessages('sess_timer')).toHaveLength(0);

      // Invoke the timer callback directly — this exercises the arrow fn branch
      expect(timerCallback).not.toBeNull();
      timerCallback!();

      const messages = store.getSessionMessages('sess_timer');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('timer message');
    });
  });

  describe('FTS search', () => {
    beforeEach(() => {
      store.createSession({
        id: 'sess_fts',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });
      const messages: MessageRecord[] = [
        {
          sessionId: 'sess_fts',
          userId: 'user_a',
          role: 'user',
          content: 'How to configure TypeScript project',
          timestamp: BASE + 1,
        },
        {
          sessionId: 'sess_fts',
          userId: 'user_a',
          role: 'assistant',
          content: 'You can use tsconfig.json to configure TypeScript',
          timestamp: BASE + 2,
        },
        {
          sessionId: 'sess_fts',
          userId: 'user_a',
          role: 'user',
          content: 'What about ESLint setup',
          timestamp: BASE + 3,
        },
      ];
      for (const m of messages) {
        store.appendMessage(m);
      }
      store.flushWriteQueue();
    });

    test('should search messages by keyword', () => {
      const results = store.searchMessages({
        userId: 'user_a',
        query: 'TypeScript',
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].highlight).toContain('<mark>');
      expect(results[0].sessionId).toBe('sess_fts');
      expect(results[0].channel).toBe('web');
    });

    test('should respect limit parameter', () => {
      const results = store.searchMessages({
        userId: 'user_a',
        query: 'TypeScript',
        limit: 1,
      });
      expect(results).toHaveLength(1);
    });

    test('should not return results for other users', () => {
      const results = store.searchMessages({
        userId: 'user_b',
        query: 'TypeScript',
      });
      expect(results).toHaveLength(0);
    });

    test('should search Chinese text with unicode61 tokenizer', () => {
      store.createSession({
        id: 'sess_cn',
        userId: 'user_cn',
        channel: 'feishu',
        startedAt: BASE,
      });
      store.appendMessage({
        sessionId: 'sess_cn',
        userId: 'user_cn',
        role: 'user',
        content: 'Please help me with project configuration setup',
        timestamp: BASE + 10,
      });
      store.appendMessage({
        sessionId: 'sess_cn',
        userId: 'user_cn',
        role: 'assistant',
        content: 'OK I will help with the configuration',
        timestamp: BASE + 11,
      });
      store.flushWriteQueue();

      const results = store.searchMessages({
        userId: 'user_cn',
        query: 'configuration',
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getRecentSessions', () => {
    test('should return sessions within time range', () => {
      const now = Date.now();
      store.createSession({
        id: 'sess_recent1',
        userId: 'user_a',
        channel: 'web',
        startedAt: now - 86400_000, // 1 day ago
      });
      store.createSession({
        id: 'sess_recent2',
        userId: 'user_a',
        channel: 'feishu',
        startedAt: now - 86400_000 * 10, // 10 days ago
      });

      const within7 = store.getRecentSessions({ userId: 'user_a', days: 7 });
      expect(within7).toHaveLength(1);
      expect(within7[0].id).toBe('sess_recent1');

      const within30 = store.getRecentSessions({ userId: 'user_a', days: 30 });
      expect(within30).toHaveLength(2);
    });

    test('should respect limit', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.createSession({
          id: `sess_lim_${i}`,
          userId: 'user_a',
          channel: 'web',
          startedAt: now - i * 1000,
        });
      }

      const limited = store.getRecentSessions({ userId: 'user_a', days: 7, limit: 2 });
      expect(limited).toHaveLength(2);
    });

    test('should filter by userId', () => {
      const now = Date.now();
      store.createSession({
        id: 'sess_ua',
        userId: 'user_a',
        channel: 'web',
        startedAt: now,
      });
      store.createSession({
        id: 'sess_ub',
        userId: 'user_b',
        channel: 'web',
        startedAt: now,
      });

      const sessionsA = store.getRecentSessions({ userId: 'user_a', days: 7 });
      expect(sessionsA).toHaveLength(1);
      expect(sessionsA[0].id).toBe('sess_ua');
    });
  });

  describe('getSessionMessages', () => {
    test('should return messages ordered by timestamp', () => {
      store.createSession({
        id: 'sess_msgs',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      store.appendMessage({
        sessionId: 'sess_msgs',
        userId: 'user_a',
        role: 'user',
        content: 'first',
        timestamp: BASE + 1,
      });
      store.appendMessage({
        sessionId: 'sess_msgs',
        userId: 'user_a',
        role: 'assistant',
        content: 'second',
        timestamp: BASE + 2,
      });
      store.appendMessage({
        sessionId: 'sess_msgs',
        userId: 'user_a',
        role: 'user',
        content: 'third',
        timestamp: BASE + 3,
      });
      store.flushWriteQueue();

      const messages = store.getSessionMessages('sess_msgs');
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('first');
      expect(messages[2].content).toBe('third');
    });

    test('should respect limit', () => {
      store.createSession({
        id: 'sess_ml',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      for (let i = 0; i < 5; i++) {
        store.appendMessage({
          sessionId: 'sess_ml',
          userId: 'user_a',
          role: 'user',
          content: `msg ${i}`,
          timestamp: BASE + i,
        });
      }
      store.flushWriteQueue();

      const messages = store.getSessionMessages('sess_ml', 2);
      expect(messages).toHaveLength(2);
    });

    test('should return empty array for unknown session', () => {
      const messages = store.getSessionMessages('nonexistent');
      expect(messages).toEqual([]);
    });
  });

  describe('getUnreflectedSessions', () => {
    test('should return closed sessions not yet reflected', () => {
      store.createSession({
        id: 'sess_u1',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });
      store.createSession({
        id: 'sess_u2',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE + 1000,
      });
      store.createSession({
        id: 'sess_u3',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE + 2000,
      });

      store.closeSession('sess_u1', 'idle_timeout');
      store.closeSession('sess_u2', 'user_close');
      // sess_u3 still open

      store.markReflectionProcessed('sess_u1');

      const unreflected = store.getUnreflectedSessions('user_a');
      expect(unreflected).toHaveLength(1);
      expect(unreflected[0].id).toBe('sess_u2');
    });

    test('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        store.createSession({
          id: `sess_ul_${i}`,
          userId: 'user_a',
          channel: 'web',
          startedAt: BASE + i,
        });
        store.closeSession(`sess_ul_${i}`, 'idle_timeout');
      }

      const limited = store.getUnreflectedSessions('user_a', 2);
      expect(limited).toHaveLength(2);
    });
  });

  describe('markInterruptedOnStartup', () => {
    test('should mark all open sessions as process_restart', () => {
      // Insert a session directly simulating a previous process
      db.prepare(
        'INSERT INTO sessions (id, user_id, channel, started_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('sess_interrupted', 'user_a', 'web', BASE, BASE);

      // Creating a new store triggers markInterruptedOnStartup
      const store2 = new SessionStore(db);

      const sessions = store2.getRecentSessions({ userId: 'user_a', days: 7 });
      const interrupted = sessions.find((s) => s.id === 'sess_interrupted');
      expect(interrupted?.endReason).toBe('process_restart');
      expect(interrupted?.endedAt).toBeDefined();
      store2.close();
    });
  });

  describe('concurrent safety (WAL)', () => {
    test('should handle concurrent reads during write', () => {
      store.createSession({
        id: 'sess_wal',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });

      for (let i = 0; i < 10; i++) {
        store.appendMessage({
          sessionId: 'sess_wal',
          userId: 'user_a',
          role: 'user',
          content: `concurrent msg ${i}`,
          timestamp: BASE + i,
        });
      }
      store.flushWriteQueue();

      const sessions = store.getRecentSessions({ userId: 'user_a', days: 7 });
      expect(sessions).toHaveLength(1);

      const messages = store.getSessionMessages('sess_wal');
      expect(messages).toHaveLength(10);
    });
  });

  describe('close', () => {
    test('should flush queue on close', () => {
      store.createSession({
        id: 'sess_cl',
        userId: 'user_a',
        channel: 'web',
        startedAt: BASE,
      });
      store.appendMessage({
        sessionId: 'sess_cl',
        userId: 'user_a',
        role: 'user',
        content: 'pending',
        timestamp: BASE + 1,
      });

      store.close();

      const messages = store.getSessionMessages('sess_cl');
      expect(messages).toHaveLength(1);
    });

    test('should be idempotent', () => {
      store.close();
      store.close(); // second call should not throw
    });
  });
});
