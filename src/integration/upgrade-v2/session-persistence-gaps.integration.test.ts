/**
 * Session & Persistence Integration Tests (SES-01 ~ SES-04)
 *
 * Verifies SQLite-backed SessionStore/TaskStore CRUD, markInterruptedOnStartup,
 * and message history round-trip through the controller.
 *
 * Real: SessionStore, TaskStore, SQLite :memory:.
 * Mock: AgentBridge (for SES-04).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SessionStore } from '../../kernel/memory/session-store';
import { TaskStore } from '../../kernel/tasking/task-store';
import {
  type ControllerTestContext,
  cleanupController,
  createMemoryDb,
  createMessage,
  createStores,
  createTestController,
} from './test-helpers';

// ── Constants ────────────────────────────────────────────────

const MOCK_WORKSPACE = '/tmp/test-workspace';
const USER_CONFIG_DIR = path.join(MOCK_WORKSPACE, 'memory');

// ── Suppress console noise ───────────────────────────────────

let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'SOUL.md'), '# Soul\nBe helpful.');
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'IDENTITY.md'), '# Identity\nTest Agent.');
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'AGENTS.md'), '# Agents\nCore protocol.');

  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ════════════════════════════════════════════════════════════════
// SES-01: SessionStore CRUD on SQLite :memory:
// ════════════════════════════════════════════════════════════════

describe('SES-01: SessionStore CRUD on SQLite :memory:', () => {
  test('create session, query it, close it, verify persistence', () => {
    const db = createMemoryDb();
    const store = new SessionStore(db);

    const sessionId = `sess_${Date.now()}`;
    const userId = 'user_ses01';

    // Create
    store.createSession({
      id: sessionId,
      userId,
      channel: 'web',
      conversationId: 'conv_ses01',
      startedAt: Date.now(),
    });

    // Query — should appear in recent sessions
    const sessions = store.getRecentSessions({ userId, days: 1, limit: 10 });
    expect(sessions.length).toBeGreaterThan(0);
    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found?.userId).toBe(userId);
    expect(found?.channel).toBe('web');
    expect(found?.endedAt).toBeUndefined();

    // Close
    store.closeSession(sessionId, 'user_end', 'test summary');

    // After close, session should have endedAt set — verify via raw DB
    const row = db
      .prepare('SELECT ended_at, end_reason, summary FROM sessions WHERE id = ?')
      .get(sessionId) as { ended_at: number; end_reason: string; summary: string } | null;

    expect(row).toBeDefined();
    expect(row?.ended_at).toBeGreaterThan(0);
    expect(row?.end_reason).toBe('user_end');
    expect(row?.summary).toBe('test summary');
  });

  test('appendMessage and retrieve via getSessionMessages', () => {
    const db = createMemoryDb();
    const store = new SessionStore(db);

    const sessionId = `sess_msg_${Date.now()}`;
    const userId = 'user_ses01b';

    store.createSession({
      id: sessionId,
      userId,
      channel: 'web',
      conversationId: 'conv_ses01b',
      startedAt: Date.now(),
    });

    store.appendMessage({
      sessionId,
      userId,
      role: 'user',
      content: 'Hello from test',
      timestamp: Date.now(),
    });
    store.appendMessage({
      sessionId,
      userId,
      role: 'assistant',
      content: 'Response from agent',
      timestamp: Date.now() + 1,
    });

    // Flush the write queue to SQLite
    store.flushWriteQueue();

    const messages = store.getSessionMessages(sessionId);
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('Hello from test');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toBe('Response from agent');
  });
});

// ════════════════════════════════════════════════════════════════
// SES-02: TaskStore state persistence
// ════════════════════════════════════════════════════════════════

describe('SES-02: TaskStore state persistence', () => {
  test('create task, update status, query by session', () => {
    const db = createMemoryDb();
    const store = new TaskStore(db);

    const taskId = `task_${Date.now()}`;
    const sessionId = `sess_${Date.now()}`;

    store.create({
      id: taskId,
      userId: 'user_ses02',
      sessionId,
      type: 'chat',
      executionMode: 'sync',
      source: 'user',
      status: 'pending',
      description: 'test task',
      createdAt: Date.now(),
    });

    // Verify task is queryable as active
    const activeTasks = store.getActiveBySession(sessionId);
    expect(activeTasks.length).toBe(1);
    expect(activeTasks[0]?.id).toBe(taskId);
    expect(activeTasks[0]?.status).toBe('pending');

    // Update to running
    const startedAt = Date.now();
    store.updateStatus(taskId, 'running', { startedAt });

    // getActiveBySession should still return it (running is active)
    const stillActive = store.getActiveBySession(sessionId);
    expect(stillActive.length).toBe(1);
    expect(stillActive[0]?.status).toBe('running');

    // Update to completed
    const completedAt = Date.now();
    store.updateStatus(taskId, 'completed', { completedAt, resultSummary: 'done' });

    // getActiveBySession should now return empty (completed is not active)
    const noLongerActive = store.getActiveBySession(sessionId);
    expect(noLongerActive.length).toBe(0);

    // Verify state in raw DB
    const row = db
      .prepare('SELECT status, completed_at, result_summary FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; completed_at: number; result_summary: string } | null;
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBeGreaterThan(0);
    expect(row?.result_summary).toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════
// SES-03: markInterruptedOnStartup
// ════════════════════════════════════════════════════════════════

describe('SES-03: markInterruptedOnStartup marks running tasks as failed', () => {
  test('running tasks become status=failed with error_message=process_restart', () => {
    const db = createMemoryDb();
    const store = new TaskStore(db);

    const sessionId = `sess_ses03_${Date.now()}`;

    // Create three tasks in different states
    const runningId1 = `task_r1_${Date.now()}`;
    const runningId2 = `task_r2_${Date.now()}`;
    const completedId = `task_c_${Date.now()}`;

    for (const id of [runningId1, runningId2]) {
      store.create({
        id,
        userId: 'user_ses03',
        sessionId,
        type: 'chat',
        executionMode: 'sync',
        source: 'user',
        status: 'pending',
        description: 'running task',
        createdAt: Date.now(),
      });
      store.updateStatus(id, 'running', { startedAt: Date.now() });
    }

    store.create({
      id: completedId,
      userId: 'user_ses03',
      sessionId,
      type: 'chat',
      executionMode: 'sync',
      source: 'user',
      status: 'pending',
      description: 'completed task',
      createdAt: Date.now(),
    });
    store.updateStatus(completedId, 'completed', { completedAt: Date.now() });

    // Simulate process restart — mark all running tasks as failed
    const count = store.markInterruptedOnStartup();
    expect(count).toBe(2); // Only the 2 running tasks

    // Running tasks should now be 'failed' with error_message='process_restart'
    for (const id of [runningId1, runningId2]) {
      const row = db.prepare('SELECT status, error_message FROM tasks WHERE id = ?').get(id) as {
        status: string;
        error_message: string;
      } | null;
      expect(row?.status).toBe('failed');
      expect(row?.error_message).toBe('process_restart');
    }

    // Completed task should remain completed
    const completedRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(completedId) as {
      status: string;
    } | null;
    expect(completedRow?.status).toBe('completed');
  });
});

// ════════════════════════════════════════════════════════════════
// SES-04: Message history round-trip through controller
// ════════════════════════════════════════════════════════════════

describe('SES-04: Message history round-trip through controller', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('assistant reply is stored in session history after handleIncomingMessage', async () => {
    const AGENT_RESPONSE = '这是来自 Agent 的回复';
    const { db, sessionStore, taskStore } = createStores();

    ctx = createTestController({
      sessionStore,
      taskStore,
      // Override agentBridge to return known content
      agentBridge: {
        execute: async (params) => {
          if (params.streamCallback) {
            await params.streamCallback({ type: 'text_delta', text: AGENT_RESPONSE });
            await params.streamCallback({ type: 'done' });
          }
          return {
            content: AGENT_RESPONSE,
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            finishedNaturally: true,
            handledBy: 'claude' as const,
          };
        },
      },
      lightLLM: undefined,
    });

    const userId = 'user_ses04';
    const conversationId = 'conv_ses04';

    const msg = createMessage({ content: '帮我分析代码', userId, conversationId });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    // Result data should contain the agent response
    const data = result.data as { content: string };
    expect(data.content).toContain(AGENT_RESPONSE);

    // Flush session store write queue
    sessionStore.flushWriteQueue();

    // Verify both user and assistant messages are in SQLite
    const messages = db
      .prepare(
        'SELECT role, content FROM session_messages WHERE user_id = ? ORDER BY timestamp ASC',
      )
      .all(userId) as Array<{ role: string; content: string }>;

    expect(messages.length).toBeGreaterThanOrEqual(2);

    const userMsg = messages.find((m) => m.role === 'user');
    const assistantMsg = messages.find((m) => m.role === 'assistant');

    expect(userMsg?.content).toContain('帮我分析代码');
    expect(assistantMsg?.content).toContain(AGENT_RESPONSE);
  });
});
