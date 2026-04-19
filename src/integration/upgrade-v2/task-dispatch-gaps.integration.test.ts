/**
 * Task Dispatch Pipeline Integration Tests (TSK-01 ~ TSK-04)
 *
 * Verifies TaskDispatcher persistence, session serialization, and history flow.
 *
 * Real: CentralController, TaskDispatcher, TaskStore, SessionManager.
 * Mock: AgentBridge, LightLLM, OV deps.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentBridge,
  AgentExecuteParams,
  AgentResult,
} from '../../kernel/agents/agent-bridge';
import {
  type ControllerTestContext,
  cleanupController,
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
// TSK-01: TaskDispatcher creates task, executes, marks completed
// ════════════════════════════════════════════════════════════════

describe('TSK-01: TaskDispatcher creates task in TaskStore and marks it completed', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('after handleIncomingMessage, TaskStore has a completed task', async () => {
    // Use createTestController WITH taskStore (default behavior — taskStore is created by createStores)
    ctx = createTestController();

    const msg = createMessage({ content: '帮我写一段代码' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);

    // Query TaskStore directly — should have at least one completed task
    const db = ctx.db;
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10').all() as Array<
      Record<string, unknown>
    >;

    expect(rows.length).toBeGreaterThan(0);

    // The task must have been completed (not pending/running/failed)
    const completedTask = rows.find((r) => r.status === 'completed');
    expect(completedTask).toBeDefined();
    expect(completedTask?.description).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════
// TSK-02: Same session messages are serialized (not parallel)
// ════════════════════════════════════════════════════════════════

describe('TSK-02: Same session messages serialized (no overlap)', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('two messages in same session execute sequentially, second starts after first completes', async () => {
    const executionOrder: string[] = [];
    let firstResolve!: () => void;
    const firstLatch = new Promise<void>((r) => {
      firstResolve = r;
    });

    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        const msgContent = params.userMessage ?? '';
        executionOrder.push(`start:${msgContent}`);

        if (msgContent.includes('first')) {
          // First message blocks until explicitly released
          await firstLatch;
        }

        executionOrder.push(`end:${msgContent}`);
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'done' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'done',
          tokenUsage: { inputTokens: 5, outputTokens: 3 },
          finishedNaturally: true,
          handledBy: 'claude' as const,
        };
      }),
    };

    ctx = createTestController({ agentBridge, lightLLM: undefined });

    const userId = 'user_tsk02';
    const conversationId = 'conv_tsk02';

    // Fire both messages concurrently — same session key
    const p1 = ctx.controller.handleIncomingMessage(
      createMessage({ content: '帮我分析 first', userId, conversationId }),
    );
    const p2 = ctx.controller.handleIncomingMessage(
      createMessage({ content: '帮我分析 second', userId, conversationId }),
    );

    // Wait a tick so first message enters execution
    await new Promise((r) => setTimeout(r, 20));

    // Second message should NOT have started yet (serialized behind first)
    const secondStartedBeforeRelease = executionOrder.some(
      (e) => e.startsWith('start:') && e.includes('second'),
    );
    expect(secondStartedBeforeRelease).toBe(false);

    // Release the first message
    firstResolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Verify strict serialization: first must fully complete before second starts
    const firstEndIdx = executionOrder.indexOf('end:帮我分析 first');
    const secondStartIdx = executionOrder.findIndex(
      (e) => e.includes('start:') && e.includes('second'),
    );
    expect(firstEndIdx).toBeGreaterThanOrEqual(0);
    expect(secondStartIdx).toBeGreaterThan(firstEndIdx);
  });
});

// ════════════════════════════════════════════════════════════════
// TSK-04: Session history persistence — both exchanges stored
// ════════════════════════════════════════════════════════════════

describe('TSK-04: Session history persistence across two exchanges', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('after two messages, SessionStore has both user+assistant message pairs', async () => {
    const { db, sessionStore, taskStore } = createStores();

    ctx = createTestController({ sessionStore, taskStore });

    const userId = 'user_tsk04';
    const conversationId = 'conv_tsk04';

    // First exchange
    const msg1 = createMessage({ content: '帮我分析代码', userId, conversationId });
    const r1 = await ctx.controller.handleIncomingMessage(msg1);
    expect(r1.success).toBe(true);

    // Second exchange
    const msg2 = createMessage({ content: '继续分析', userId, conversationId });
    const r2 = await ctx.controller.handleIncomingMessage(msg2);
    expect(r2.success).toBe(true);

    // Flush write queue (SessionStore batches writes)
    sessionStore.flushWriteQueue();

    // Query session_messages — should have at least 4 rows (2 user + 2 assistant)
    const messages = db
      .prepare(
        'SELECT role, content FROM session_messages WHERE user_id = ? ORDER BY timestamp ASC',
      )
      .all(userId) as Array<{ role: string; content: string }>;

    expect(messages.length).toBeGreaterThanOrEqual(4);

    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

    // First user message content should be preserved
    expect(userMessages[0]?.content).toContain('帮我分析代码');
    expect(userMessages[1]?.content).toContain('继续分析');
  });
});
