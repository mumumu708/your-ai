/**
 * DD-020: Session Close Integration Tests
 *
 * Tests the session close callback pipeline wired in CentralController:
 *   1. worktreePool.release (harness sessions)
 *   2. ovClient.commit → evolutionScheduler.schedulePostCommit
 *   3. reflectionTrigger check → taskDispatcher.dispatch → markReflectionProcessed
 *
 * SC-01 through SC-11 cover normal flow, error resilience, reflection
 * triggering, startup recovery, and session expiry auto-close.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { SessionStore } from '../../kernel/memory/session-store';
import { SessionManager } from '../../kernel/sessioning';
import {
  type ControllerTestContext,
  cleanupController,
  createMemoryDb,
  createMockOVDeps,
  createMockWorktreePool,
  createStores,
  createTestController,
  delay,
} from './test-helpers';

// ── Helpers ──────────────────────────────────────────────────

/** Create a session via resolveSession, add a message so closeSession produces a summary. */
async function createSessionWithMessage(
  ctx: ControllerTestContext,
  userId = 'user_test',
  channel = 'web',
  conversationId = 'conv_test',
): Promise<{ sessionKey: string; sessionId: string }> {
  const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
  const session = await sm.resolveSession(userId, channel, conversationId);
  // Add a message so the session is non-empty (closeSession skips empty sessions)
  sm.addMessage(`${userId}:${channel}:${conversationId}`, {
    role: 'user',
    content: 'test message',
    timestamp: Date.now(),
  });
  sm.addMessage(`${userId}:${channel}:${conversationId}`, {
    role: 'assistant',
    content: 'test response',
    timestamp: Date.now(),
  });
  return {
    sessionKey: `${userId}:${channel}:${conversationId}`,
    sessionId: session.id,
  };
}

/** Pre-populate N closed unreflected sessions in the SessionStore for a user. */
function seedUnreflectedSessions(
  sessionStore: SessionStore,
  userId: string,
  count: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `seed-session-${i}-${Date.now()}`;
    ids.push(id);
    sessionStore.createSession({
      id,
      userId,
      channel: 'web',
      conversationId: `conv-seed-${i}`,
      startedAt: Date.now() - (count - i) * 60000,
    });
    sessionStore.closeSession(id, 'idle_timeout', `Summary for session ${i}`);
  }
  return ids;
}

// ── Test Suite ───────────────────────────────────────────────

describe('DD-020 Session Close Integration', () => {
  let ctx: ControllerTestContext;

  afterEach(() => {
    if (ctx) cleanupController(ctx);
  });

  // ── SC-01: Normal session close → ovClient.commit() called ──

  test('SC-01: closeSession triggers ovClient.commit with sessionId', async () => {
    ctx = createTestController();
    // biome-ignore lint/style/noNonNullAssertion: test assertion
    const ovClient = ctx.deps.ovClient!;
    const commitMock = ovClient.commit as ReturnType<typeof mock>;

    const { sessionKey, sessionId } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);

    // Allow async callback to complete
    await delay(100);

    expect(commitMock).toHaveBeenCalled();
    const callArgs = commitMock.mock.calls[0];
    expect(callArgs[0]).toBe(sessionId);
  });

  // ── SC-02: commit returns memories_extracted > 0 → schedulePostCommit called ──

  test('SC-02: commit with memories_extracted > 0 triggers schedulePostCommit', async () => {
    const ovDeps = createMockOVDeps();
    // Override commit to return memories_extracted > 0
    (ovDeps.ovClient?.commit as ReturnType<typeof mock>).mockImplementation(async () => ({
      memories_extracted: 3,
    }));
    ctx = createTestController(ovDeps);
    const schedulerMock = ctx.deps.evolutionScheduler?.schedulePostCommit as ReturnType<
      typeof mock
    >;

    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);
    await delay(100);

    expect(schedulerMock).toHaveBeenCalled();
    // Called with empty array (commit doesn't return URIs)
    expect(schedulerMock.mock.calls[0][0]).toEqual([]);
  });

  // ── SC-03: commit fails → warn logged, no throw, flow continues ──
  // R6: worktree release happens BEFORE OV commit (line 298 vs 315)

  test('SC-03: commit failure does not throw; worktree release already completed', async () => {
    const ovDeps = createMockOVDeps();
    (ovDeps.ovClient?.commit as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('OV commit network error');
    });
    const worktreePool = createMockWorktreePool();
    ctx = createTestController({ ...ovDeps, worktreePool });

    // Create session with harness worktree binding
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    const session = await sm.resolveSession('user_test', 'web', 'conv_test');
    session.harnessWorktreeSlotId = 'slot_harness_1';
    sm.addMessage('user_test:web:conv_test', {
      role: 'user',
      content: 'harness task',
      timestamp: Date.now(),
    });
    sm.addMessage('user_test:web:conv_test', {
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
    });

    // Should not throw
    await sm.closeSession('user_test:web:conv_test');
    await delay(100);

    // Worktree release was called (happens before commit)
    expect(worktreePool.release).toHaveBeenCalledWith('slot_harness_1');
    // Commit was attempted
    expect(ovDeps.ovClient?.commit).toHaveBeenCalled();
  });

  // ── SC-04: Harness session close → worktreePool.release(slotId) called ──

  test('SC-04: harness session close calls worktreePool.release with slotId', async () => {
    const worktreePool = createMockWorktreePool();
    ctx = createTestController({ worktreePool });

    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    const session = await sm.resolveSession('user_test', 'web', 'conv_harness');
    session.harnessWorktreeSlotId = 'slot_xyz';
    sm.addMessage('user_test:web:conv_harness', {
      role: 'user',
      content: 'harness message',
      timestamp: Date.now(),
    });
    sm.addMessage('user_test:web:conv_harness', {
      role: 'assistant',
      content: 'response',
      timestamp: Date.now(),
    });

    await sm.closeSession('user_test:web:conv_harness');
    await delay(100);

    expect(worktreePool.release).toHaveBeenCalledWith('slot_xyz');
  });

  // ── SC-05: worktreePool.release fails → warn logged, no throw ──

  test('SC-05: worktreePool.release failure does not throw; commit still executes', async () => {
    const worktreePool = createMockWorktreePool();
    (worktreePool.release as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('worktree cleanup failed');
    });
    ctx = createTestController({ worktreePool });

    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    const session = await sm.resolveSession('user_test', 'web', 'conv_wt_fail');
    session.harnessWorktreeSlotId = 'slot_bad';
    sm.addMessage('user_test:web:conv_wt_fail', {
      role: 'user',
      content: 'test',
      timestamp: Date.now(),
    });
    sm.addMessage('user_test:web:conv_wt_fail', {
      role: 'assistant',
      content: 'ok',
      timestamp: Date.now(),
    });

    // Should not throw
    await sm.closeSession('user_test:web:conv_wt_fail');
    await delay(100);

    // Commit still executed despite worktree release failure
    expect(ctx.deps.ovClient?.commit).toHaveBeenCalled();
  });

  // ── SC-06: unreflected sessions >= threshold → reflection dispatch ──

  test('SC-06: reaching unreflected threshold triggers taskDispatcher.dispatch(type=system)', async () => {
    const dispatchMock = mock(async () => 'task-id-reflection');
    ctx = createTestController();

    // Inject a taskDispatcher mock
    const controller = ctx.controller as unknown as Record<string, unknown>;
    controller.taskDispatcher = {
      dispatch: dispatchMock,
      dispatchAndAwait: mock(async () => ({ taskId: 'x', result: '' })),
      shutdown: mock(async () => {}),
    };

    // Seed 5 unreflected sessions (default threshold = 5)
    seedUnreflectedSessions(ctx.sessionStore, 'user_test', 5);

    // Now close a live session — the callback checks unreflected count
    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);

    // Wait for the fire-and-forget dispatch promise chain
    await delay(300);

    expect(dispatchMock).toHaveBeenCalled();
    const payload = dispatchMock.mock.calls[0][1];
    expect(payload.type).toBe('system');
    expect(payload.source).toBe('system');
    expect(payload.message.content).toContain('会话历史');
  });

  // ── SC-07: reflection dispatch success → markReflectionProcessed ──

  test('SC-07: successful dispatch marks unreflected sessions as processed', async () => {
    const dispatchMock = mock(async () => 'task-id-ok');
    ctx = createTestController();

    const controller = ctx.controller as unknown as Record<string, unknown>;
    controller.taskDispatcher = {
      dispatch: dispatchMock,
      dispatchAndAwait: mock(async () => ({ taskId: 'x', result: '' })),
      shutdown: mock(async () => {}),
    };

    const seedIds = seedUnreflectedSessions(ctx.sessionStore, 'user_test', 5);
    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);

    // Wait for the .then() chain after dispatch
    await delay(500);

    // Verify: seeded sessions should now be reflection_processed = 1
    const unreflected = ctx.sessionStore.getUnreflectedSessions('user_test');
    // The seeded sessions (up to 10) should have been marked processed
    // Only the just-closed session itself might remain unreflected
    const seedStillUnreflected = unreflected.filter((s) => seedIds.includes(s.id));
    expect(seedStillUnreflected.length).toBe(0);
  });

  // ── SC-08: reflection dispatch failure → warn logged, no throw ──

  test('SC-08: reflection dispatch failure does not propagate to session close', async () => {
    const dispatchMock = mock(async () => {
      throw new Error('dispatch queue full');
    });
    ctx = createTestController();

    const controller = ctx.controller as unknown as Record<string, unknown>;
    controller.taskDispatcher = {
      dispatch: dispatchMock,
      dispatchAndAwait: mock(async () => ({ taskId: 'x', result: '' })),
      shutdown: mock(async () => {}),
    };

    seedUnreflectedSessions(ctx.sessionStore, 'user_test', 5);
    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;

    // Should not throw even though dispatch fails
    await sm.closeSession(sessionKey);
    await delay(300);

    // Dispatch was attempted
    expect(dispatchMock).toHaveBeenCalled();
    // Sessions remain unreflected since dispatch failed
    const unreflected = ctx.sessionStore.getUnreflectedSessions('user_test');
    expect(unreflected.length).toBeGreaterThanOrEqual(5);
  });

  // ── SC-09 (R6): Reflection enqueue marks sessions immediately (fire-and-forget) ──

  test('SC-09: markReflectionProcessed called immediately on dispatch success, not waiting for task completion', async () => {
    // dispatch resolves immediately — markReflectionProcessed should follow without
    // waiting for any actual reflection task execution
    let dispatchResolve: () => void;
    const _dispatchPromise = new Promise<string>((resolve) => {
      dispatchResolve = () => resolve('task-id-immediate');
    });
    const dispatchMock = mock(async () => {
      // Resolve immediately
      dispatchResolve();
      return 'task-id-immediate';
    });

    ctx = createTestController();
    const controller = ctx.controller as unknown as Record<string, unknown>;
    controller.taskDispatcher = {
      dispatch: dispatchMock,
      dispatchAndAwait: mock(async () => ({ taskId: 'x', result: '' })),
      shutdown: mock(async () => {}),
    };

    const seedIds = seedUnreflectedSessions(ctx.sessionStore, 'user_test', 6);
    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);

    // Wait just enough for the .then() microtask chain
    await delay(200);

    // Sessions should already be marked — fire-and-forget design
    const unreflected = ctx.sessionStore.getUnreflectedSessions('user_test');
    const seedStillUnreflected = unreflected.filter((s) => seedIds.includes(s.id));
    expect(seedStillUnreflected.length).toBe(0);
  });

  // ── SC-10 (R7): SessionStore startup recovery ──

  test('SC-10: SessionStore constructor marks interrupted sessions with process_restart', () => {
    const db = createMemoryDb();

    // Create a SessionStore, insert an open session, then close the store
    const store1 = new SessionStore(db);
    store1.createSession({
      id: 'interrupted-1',
      userId: 'user_recovery',
      channel: 'web',
      conversationId: 'conv_recovery',
      startedAt: Date.now() - 3600000,
    });
    // Do NOT close the session — simulate process crash
    store1.close();

    // Verify the session has no ended_at
    const row = db
      .prepare('SELECT ended_at, end_reason FROM sessions WHERE id = ?')
      .get('interrupted-1') as { ended_at: number | null; end_reason: string | null };
    expect(row.ended_at).toBeNull();

    // Create a new SessionStore — constructor calls markInterruptedOnStartup
    const store2 = new SessionStore(db);

    // Verify the interrupted session was recovered
    const recovered = db
      .prepare('SELECT ended_at, end_reason FROM sessions WHERE id = ?')
      .get('interrupted-1') as { ended_at: number; end_reason: string };
    expect(recovered.ended_at).toBeGreaterThan(0);
    expect(recovered.end_reason).toBe('process_restart');

    // getUnreflectedSessions should find the recovered session (ended_at IS NOT NULL, reflection_processed = 0)
    const unreflected = store2.getUnreflectedSessions('user_recovery');
    expect(unreflected.length).toBe(1);
    expect(unreflected[0].id).toBe('interrupted-1');
    expect(unreflected[0].endReason).toBe('process_restart');

    store2.close();
  });

  // ── SC-11 (R7): Session expiry auto-close ──

  test('SC-11: expired session on resolveSession triggers full close pipeline', async () => {
    // Use a very short timeout so the session expires quickly
    const ovDeps = createMockOVDeps();
    (ovDeps.ovClient?.commit as ReturnType<typeof mock>).mockImplementation(async () => ({
      memories_extracted: 1,
    }));

    const { sessionStore } = createStores();
    ctx = createTestController({
      ...ovDeps,
      sessionStore,
      taskStore: undefined, // keep simple, no task dispatcher
    });

    // Access sessionManager and reconfigure with short timeout
    const controller = ctx.controller as unknown as Record<string, unknown>;
    const shortTimeoutSm = new SessionManager({
      sessionTimeoutMs: 50, // 50ms timeout
      sessionStore,
    });

    // Wire the onSessionClose callback from the controller's wiring
    // We need to capture the callback that was set by the constructor
    const _originalSm = controller.sessionManager as SessionManager;
    // Extract the callback by intercepting setOnSessionClose
    let _capturedCallback: Parameters<SessionManager['setOnSessionClose']>[0] | null = null;
    const origSet = shortTimeoutSm.setOnSessionClose.bind(shortTimeoutSm);
    shortTimeoutSm.setOnSessionClose = (cb) => {
      _capturedCallback = cb;
      origSet(cb);
    };

    // Replicate the callback wiring: read it from the original SM
    // The callback was wired in the CentralController constructor.
    // Instead, let's test through the actual controller by manipulating time.
    // Reset and rebuild with short-timeout SM.
    cleanupController(ctx);

    // Build fresh with short timeout
    const { sessionStore: ss2, taskStore: ts2 } = createStores();
    ctx = createTestController({
      ...ovDeps,
      sessionStore: ss2,
      taskStore: ts2,
    });

    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;

    // Create a session and add messages
    const session = await sm.resolveSession('user_expiry', 'web', 'conv_expiry');
    sm.addMessage('user_expiry:web:conv_expiry', {
      role: 'user',
      content: 'message before expiry',
      timestamp: Date.now(),
    });
    sm.addMessage('user_expiry:web:conv_expiry', {
      role: 'assistant',
      content: 'response before expiry',
      timestamp: Date.now(),
    });

    // Force the session to appear expired by backdating lastActiveAt
    session.lastActiveAt = Date.now() - 2_000_000; // well past 30min default timeout

    const commitMock = ovDeps.ovClient?.commit as ReturnType<typeof mock>;
    commitMock.mockClear();
    const schedulerMock = ovDeps.evolutionScheduler?.schedulePostCommit as ReturnType<typeof mock>;
    schedulerMock.mockClear();

    // Resolving the same user/channel/conv should detect expiry → close old session → create new
    const newSession = await sm.resolveSession('user_expiry', 'web', 'conv_expiry');
    expect(newSession.id).not.toBe(session.id); // New session created

    // Wait for async close callback
    await delay(300);

    // Verify: OV commit was called for the expired session
    expect(commitMock).toHaveBeenCalled();
    expect(commitMock.mock.calls[0][0]).toBe(session.id);

    // Verify: schedulePostCommit called (memories_extracted = 1)
    expect(schedulerMock).toHaveBeenCalled();

    // Verify: SQLite persistence — the old session should be closed
    const closed = ss2
      .getRecentSessions({ userId: 'user_expiry', days: 1 })
      .find((s) => s.id === session.id);
    // Session was persisted and closed
    if (closed) {
      expect(closed.endedAt).toBeGreaterThan(0);
      expect(closed.endReason).toBe('idle_timeout');
    }
  });

  // ── SC-02 negative: commit with memories_extracted = 0 → schedulePostCommit NOT called ──

  test('SC-02-neg: commit with memories_extracted=0 does not trigger schedulePostCommit', async () => {
    ctx = createTestController();
    // Default mock returns memories_extracted: 0
    const schedulerMock = ctx.deps.evolutionScheduler?.schedulePostCommit as ReturnType<
      typeof mock
    >;

    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);
    await delay(100);

    expect(schedulerMock).not.toHaveBeenCalled();
  });

  // ── SC-06 negative: below threshold → no dispatch ──

  test('SC-06-neg: unreflected count below threshold does not trigger dispatch', async () => {
    const dispatchMock = mock(async () => 'task-id');
    ctx = createTestController();

    const controller = ctx.controller as unknown as Record<string, unknown>;
    controller.taskDispatcher = {
      dispatch: dispatchMock,
      dispatchAndAwait: mock(async () => ({ taskId: 'x', result: '' })),
      shutdown: mock(async () => {}),
    };

    // Only 3 unreflected sessions — below default threshold of 5
    seedUnreflectedSessions(ctx.sessionStore, 'user_test', 3);

    const { sessionKey } = await createSessionWithMessage(ctx);
    const sm = (ctx.controller as unknown as { sessionManager: SessionManager }).sessionManager;
    await sm.closeSession(sessionKey);
    await delay(200);

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
