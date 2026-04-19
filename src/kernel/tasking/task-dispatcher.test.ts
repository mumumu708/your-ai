import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BotMessage } from '../../shared/messaging/bot-message.types';
import type { TaskPayload, TaskRecord } from '../../shared/tasking/task.types';
import { TaskDispatcher, type TaskHandler } from './task-dispatcher';
import { TaskStore } from './task-store';

function makeMessage(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    channel: 'web',
    userId: 'user_a',
    userName: 'Test User',
    conversationId: 'conv_1',
    content: 'Hello world',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function makePayload(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    type: 'chat',
    message: makeMessage(overrides.message as Partial<BotMessage>),
    source: 'user',
    ...overrides,
  };
}

/**
 * Helper: creates a deferred handler that can be resolved/rejected externally.
 */
function deferredHandler(): {
  handler: TaskHandler;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  calls: Array<{ task: TaskRecord; payload: TaskPayload; signal: AbortSignal }>;
} {
  const calls: Array<{ task: TaskRecord; payload: TaskPayload; signal: AbortSignal }> = [];
  let _resolve: (v: string) => void = () => {};
  let _reject: (e: Error) => void = () => {};

  const handler: TaskHandler = (task, payload, signal) => {
    calls.push({ task, payload, signal });
    return new Promise<string>((res, rej) => {
      _resolve = res;
      _reject = rej;
      // Auto-reject on abort
      signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
    });
  };

  return {
    handler,
    get resolve() {
      return _resolve;
    },
    get reject() {
      return _reject;
    },
    calls,
  };
}

describe('TaskDispatcher', () => {
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

  describe('dispatch', () => {
    test('should create task in DB with pending status', async () => {
      const handler: TaskHandler = async () => 'done';
      const dispatcher = new TaskDispatcher(store, handler);

      const payload = makePayload();
      const taskId = await dispatcher.dispatch('sess_1', payload);

      expect(taskId).toBeDefined();
      // Task was created (may already be completed by now due to immediate execution)
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row.user_id).toBe('user_a');
      expect(row.session_id).toBe('sess_1');
      expect(row.type).toBe('chat');
    });

    test('should truncate description to 200 chars', async () => {
      const handler: TaskHandler = async () => 'done';
      const dispatcher = new TaskDispatcher(store, handler);

      const longContent = 'A'.repeat(500);
      const payload = makePayload({ message: makeMessage({ content: longContent }) });
      const taskId = await dispatcher.dispatch('sess_1', payload);

      const row = db.prepare('SELECT description FROM tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect((row.description as string).length).toBe(200);
    });
  });

  describe('task execution lifecycle', () => {
    test('should update status to running then completed', async () => {
      const deferred = deferredHandler();
      const dispatcher = new TaskDispatcher(store, deferred.handler);

      const taskId = await dispatcher.dispatch('sess_1', makePayload());

      // Wait for handler to be called
      await vi_wait(() => deferred.calls.length > 0);
      expect(deferred.calls).toHaveLength(1);

      // Task should be running in DB
      const runningRow = db
        .prepare('SELECT status, started_at FROM tasks WHERE id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(runningRow.status).toBe('running');
      expect(runningRow.started_at).toBeDefined();

      // Resolve the handler
      deferred.resolve('Task completed successfully');

      // Wait for completion
      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Record<
          string,
          unknown
        >;
        return r.status === 'completed';
      });

      const completedRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(completedRow.status).toBe('completed');
      expect(completedRow.completed_at).toBeDefined();
      expect(completedRow.result_summary).toBe('Task completed successfully');
    });

    test('should mark failed tasks with error_message', async () => {
      const deferred = deferredHandler();
      const dispatcher = new TaskDispatcher(store, deferred.handler);

      const taskId = await dispatcher.dispatch('sess_1', makePayload());
      await vi_wait(() => deferred.calls.length > 0);

      deferred.reject(new Error('Something went wrong'));

      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Record<
          string,
          unknown
        >;
        return r.status === 'failed';
      });

      const row = db
        .prepare('SELECT status, error_message FROM tasks WHERE id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row.status).toBe('failed');
      expect(row.error_message).toBe('Something went wrong');
    });

    test('should stringify non-Error thrown values as error_message', async () => {
      const handler: TaskHandler = async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'raw string error';
      };
      const dispatcher = new TaskDispatcher(store, handler);

      const taskId = await dispatcher.dispatch('sess_1', makePayload());

      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Record<
          string,
          unknown
        >;
        return r.status === 'failed';
      });

      const row = db
        .prepare('SELECT status, error_message FROM tasks WHERE id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row.status).toBe('failed');
      expect(row.error_message).toBe('raw string error');
    });
  });

  describe('session lock error recovery', () => {
    test('session lock catch handler absorbs executeTask rejection', async () => {
      // Force executeTask to throw before its own try/catch by making
      // taskStore.updateStatus throw only on the first 'running' update.
      // This causes the first task's executeTask to reject, which exercises
      // the `currentLock.catch(() => {})` handler in startTask.
      let updateCallCount = 0;
      const originalUpdate = store.updateStatus.bind(store);
      spyOn(store, 'updateStatus').mockImplementation(
        (
          id: string,
          status: Parameters<typeof store.updateStatus>[1],
          extra?: Record<string, unknown>,
        ) => {
          updateCallCount++;
          if (updateCallCount === 1) {
            // First updateStatus call: 'running' update inside executeTask before the try block
            throw new Error('DB failure on first running update');
          }
          return originalUpdate(id, status, extra);
        },
      );

      const handler: TaskHandler = async () => 'done';
      // Use high concurrency so both tasks start via startTask directly (not processQueue),
      // avoiding a deadlock from task1's finally never running (pre-try throw).
      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 10 });

      // Task1 triggers the mocked failure — executeTask rejects before try, exercises catch(() => {})
      const taskId1 = await dispatcher.dispatch(
        'sess_lock',
        makePayload({ message: makeMessage({ id: 'lk1' }) }),
      );

      // Task2 in same session — chains on session lock via prevLock.then(...)
      // When task1's lock rejects, catch(() => {}) swallows it, so task2's executeTask eventually runs
      const taskId2 = await dispatcher.dispatch(
        'sess_lock',
        makePayload({ message: makeMessage({ id: 'lk2' }) }),
      );

      // Wait for task2 to complete — proves the catch handler unblocked the session chain
      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
          string,
          unknown
        >;
        return r.status === 'completed';
      });

      expect(taskId1).toBeDefined();
      expect(taskId2).toBeDefined();
    });
  });

  describe('session-level serialization', () => {
    test('two tasks in same session should execute sequentially', async () => {
      const executionOrder: string[] = [];
      const barriers: Array<{ resolve: (v: string) => void }> = [];

      const handler: TaskHandler = async (task) => {
        executionOrder.push(`start:${task.id}`);
        return new Promise<string>((resolve) => {
          barriers.push({ resolve });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      const msg1 = makeMessage({ id: 'msg_1' });
      const msg2 = makeMessage({ id: 'msg_2' });

      await dispatcher.dispatch('sess_same', makePayload({ message: msg1 }));
      await dispatcher.dispatch('sess_same', makePayload({ message: msg2 }));

      // Wait for first handler call
      await vi_wait(() => barriers.length >= 1);

      // Only first task should have started
      expect(executionOrder).toHaveLength(1);
      expect(executionOrder[0]).toStartWith('start:');

      // Complete first task
      barriers[0].resolve('done');

      // Wait for second to start
      await vi_wait(() => barriers.length >= 2);
      expect(executionOrder).toHaveLength(2);
    });
  });

  describe('cross-session concurrency', () => {
    test('two tasks in different sessions should execute in parallel', async () => {
      const startedSessions: string[] = [];
      const barriers: Array<{ resolve: (v: string) => void }> = [];

      const handler: TaskHandler = async (task) => {
        startedSessions.push(task.sessionId);
        return new Promise<string>((resolve) => {
          barriers.push({ resolve });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      const msg1 = makeMessage({ id: 'msg_1' });
      const msg2 = makeMessage({ id: 'msg_2' });

      await dispatcher.dispatch('sess_a', makePayload({ message: msg1 }));
      await dispatcher.dispatch('sess_b', makePayload({ message: msg2 }));

      // Both should start
      await vi_wait(() => startedSessions.length >= 2);
      expect(startedSessions).toContain('sess_a');
      expect(startedSessions).toContain('sess_b');

      // Clean up
      for (const b of barriers) b.resolve('done');
    });
  });

  describe('concurrency limit', () => {
    test('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const barriers: Array<{ resolve: (v: string) => void }> = [];

      const handler: TaskHandler = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        return new Promise<string>((resolve) => {
          barriers.push({
            resolve: (v: string) => {
              concurrent--;
              resolve(v);
            },
          });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 2 });

      // Dispatch 4 tasks to different sessions
      for (let i = 0; i < 4; i++) {
        await dispatcher.dispatch(
          `sess_${i}`,
          makePayload({ message: makeMessage({ id: `m_${i}` }) }),
        );
      }

      // Wait for 2 to start (concurrency limit)
      await vi_wait(() => barriers.length >= 2);

      // Small delay to ensure no more start
      await new Promise((r) => setTimeout(r, 50));
      expect(barriers).toHaveLength(2);
      expect(maxConcurrent).toBe(2);

      // Complete first, should allow third to start
      barriers[0].resolve('done');
      await vi_wait(() => barriers.length >= 3);

      // Complete second
      barriers[1].resolve('done');
      await vi_wait(() => barriers.length >= 4);

      // Complete remaining
      barriers[2].resolve('done');
      barriers[3].resolve('done');
    });
  });

  describe('cancelBySession', () => {
    test('should cancel running task and remove pending tasks', async () => {
      const deferred = deferredHandler();
      const dispatcher = new TaskDispatcher(store, deferred.handler, { concurrency: 1 });

      // Dispatch 2 tasks to same session — first runs, second queued as pending
      const msg1 = makeMessage({ id: 'msg_c1' });
      const msg2 = makeMessage({ id: 'msg_c2' });

      const taskId1 = await dispatcher.dispatch('sess_cancel', makePayload({ message: msg1 }));

      // Fill concurrency with another session so second task stays pending
      const _blockerDeferred = deferredHandler();
      // Actually with concurrency 1, second task will be in pendingQueue
      const _taskId2 = await dispatcher.dispatch('sess_cancel', makePayload({ message: msg2 }));

      // Wait for first to start executing
      await vi_wait(() => deferred.calls.length > 0);

      const cancelled = dispatcher.cancelBySession('sess_cancel');
      expect(cancelled).toBeGreaterThanOrEqual(1);

      // Wait for the running task to settle as cancelled
      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId1) as Record<
          string,
          unknown
        >;
        return r.status === 'cancelled';
      });

      const row1 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId1) as Record<
        string,
        unknown
      >;
      expect(row1.status).toBe('cancelled');
    });
  });

  describe('cancelByMessageId', () => {
    test('should cancel running task by message ID', async () => {
      const deferred = deferredHandler();
      const dispatcher = new TaskDispatcher(store, deferred.handler);

      const msgId = 'msg_cancel_me';
      const taskId = await dispatcher.dispatch(
        'sess_1',
        makePayload({ message: makeMessage({ id: msgId }) }),
      );

      await vi_wait(() => deferred.calls.length > 0);

      const result = dispatcher.cancelByMessageId(msgId);
      expect(result).toBe(true);

      // Wait for cancelled status
      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as Record<
          string,
          unknown
        >;
        return r.status === 'cancelled';
      });
    });

    test('should cancel pending task by message ID', async () => {
      const deferred = deferredHandler();
      const dispatcher = new TaskDispatcher(store, deferred.handler, { concurrency: 1 });

      // First task fills the concurrency slot
      await dispatcher.dispatch(
        'sess_a',
        makePayload({ message: makeMessage({ id: 'msg_blocker' }) }),
      );
      await vi_wait(() => deferred.calls.length > 0);

      // Second task goes to pending queue (different session but concurrency is 1)
      const pendingMsgId = 'msg_pending_cancel';
      const taskId2 = await dispatcher.dispatch(
        'sess_b',
        makePayload({ message: makeMessage({ id: pendingMsgId }) }),
      );

      const result = dispatcher.cancelByMessageId(pendingMsgId);
      expect(result).toBe(true);

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe('cancelled');

      // Clean up
      deferred.resolve('done');
    });

    test('should return false for unknown message ID', async () => {
      const handler: TaskHandler = async () => 'done';
      const dispatcher = new TaskDispatcher(store, handler);

      expect(dispatcher.cancelByMessageId('nonexistent')).toBe(false);
    });
  });

  describe('getActiveTasks', () => {
    test('should return running tasks', async () => {
      const deferred = deferredHandler();
      const dispatcher = new TaskDispatcher(store, deferred.handler);

      await dispatcher.dispatch('sess_1', makePayload());
      await vi_wait(() => deferred.calls.length > 0);

      const active = dispatcher.getActiveTasks();
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('running');

      // Filter by session
      expect(dispatcher.getActiveTasks('sess_1')).toHaveLength(1);
      expect(dispatcher.getActiveTasks('sess_other')).toHaveLength(0);

      deferred.resolve('done');
    });
  });

  describe('shutdown', () => {
    test('should cancel all running and mark pending as cancelled', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      const handler: TaskHandler = async (_task, _payload, signal) => {
        return new Promise<string>((resolve, reject) => {
          barriers.push({ resolve });
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 1 });

      const taskId1 = await dispatcher.dispatch(
        'sess_1',
        makePayload({ message: makeMessage({ id: 'm1' }) }),
      );
      const taskId2 = await dispatcher.dispatch(
        'sess_2',
        makePayload({ message: makeMessage({ id: 'm2' }) }),
      );

      // Wait for first to be running
      await vi_wait(() => barriers.length > 0);

      await dispatcher.shutdown();

      // First should be cancelled (was running, got aborted)
      const row1 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId1) as Record<
        string,
        unknown
      >;
      expect(row1.status).toBe('cancelled');

      // Second should be cancelled (was pending)
      const row2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
        string,
        unknown
      >;
      expect(row2.status).toBe('cancelled');
    });
  });

  describe('cancel while waiting for session lock (CR-03)', () => {
    test('cancelBySession cancels task waiting for lock and marks it cancelled', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      const handler: TaskHandler = async (_task, _payload, signal) => {
        return new Promise<string>((resolve, reject) => {
          barriers.push({ resolve });
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      // task1 runs first and holds the session lock
      const taskId1 = await dispatcher.dispatch(
        'sess_lock_cancel',
        makePayload({ message: makeMessage({ id: 'lk_msg_1' }) }),
      );
      await vi_wait(() => barriers.length > 0);

      // task2 chains on task1's session lock — it enters waitingTasks
      const taskId2 = await dispatcher.dispatch(
        'sess_lock_cancel',
        makePayload({ message: makeMessage({ id: 'lk_msg_2' }) }),
      );

      // Cancel both tasks by session (task2 is still waiting for lock)
      const cancelled = dispatcher.cancelBySession('sess_lock_cancel');
      expect(cancelled).toBeGreaterThanOrEqual(2);

      // Resolve task1 so the lock chain proceeds
      barriers[0].resolve('done');

      // task2 should become cancelled (abort signal was set before lock resolved)
      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
          string,
          unknown
        >;
        return r.status === 'cancelled';
      });

      const row2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
        string,
        unknown
      >;
      expect(row2.status).toBe('cancelled');
      void taskId1;
    });

    test('cancelByMessageId cancels task waiting for lock', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      const handler: TaskHandler = async (_task, _payload, signal) => {
        return new Promise<string>((resolve, reject) => {
          barriers.push({ resolve });
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      // task1 holds the session lock
      await dispatcher.dispatch(
        'sess_lk2',
        makePayload({ message: makeMessage({ id: 'lk2_msg_1' }) }),
      );
      await vi_wait(() => barriers.length > 0);

      // task2 waits for lock
      const waitingMsgId = 'lk2_msg_2';
      const taskId2 = await dispatcher.dispatch(
        'sess_lk2',
        makePayload({ message: makeMessage({ id: waitingMsgId }) }),
      );

      const result = dispatcher.cancelByMessageId(waitingMsgId);
      expect(result).toBe(true);

      // Resolve task1 so lock chain moves forward
      barriers[0].resolve('done');

      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
          string,
          unknown
        >;
        return r.status === 'cancelled';
      });

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe('cancelled');
    });

    test('shutdown cancels tasks waiting for lock', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      const handler: TaskHandler = async (_task, _payload, signal) => {
        return new Promise<string>((resolve, reject) => {
          barriers.push({ resolve });
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      await dispatcher.dispatch(
        'sess_lk3',
        makePayload({ message: makeMessage({ id: 'lk3_msg_1' }) }),
      );
      await vi_wait(() => barriers.length > 0);

      const taskId2 = await dispatcher.dispatch(
        'sess_lk3',
        makePayload({ message: makeMessage({ id: 'lk3_msg_2' }) }),
      );

      // Shutdown — cancels running + waiting
      // Resolve barrier first so the running task unblocks after abort
      void dispatcher.shutdown();
      barriers[0].resolve('done');

      await vi_wait(() => {
        const r = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
          string,
          unknown
        >;
        return r.status === 'cancelled';
      });

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe('cancelled');
    });
  });

  describe('getRunningCount / getPendingCount', () => {
    test('should report running and pending counts', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      const handler: TaskHandler = async () => {
        return new Promise<string>((resolve) => {
          barriers.push({ resolve });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 1 });

      expect(dispatcher.getRunningCount()).toBe(0);
      expect(dispatcher.getPendingCount()).toBe(0);

      await dispatcher.dispatch('sess_1', makePayload({ message: makeMessage({ id: 'rc1' }) }));
      await vi_wait(() => barriers.length > 0);

      expect(dispatcher.getRunningCount()).toBe(1);

      // Second task goes to pending (concurrency 1)
      await dispatcher.dispatch('sess_2', makePayload({ message: makeMessage({ id: 'rc2' }) }));
      expect(dispatcher.getPendingCount()).toBe(1);

      // Clean up
      barriers[0].resolve('done');
      await vi_wait(() => barriers.length >= 2);
      barriers[1].resolve('done');
    });
  });

  describe('dispatchAndAwait', () => {
    test('should return taskId and handler result on success', async () => {
      const handler: TaskHandler = async () => 'hello from handler';
      const dispatcher = new TaskDispatcher(store, handler);

      const { taskId, result } = await dispatcher.dispatchAndAwait('sess_1', makePayload());

      expect(taskId).toBeDefined();
      expect(result).toBe('hello from handler');

      const row = db
        .prepare('SELECT status, result_summary FROM tasks WHERE id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row.status).toBe('completed');
      expect(row.result_summary).toBe('hello from handler');
    });

    test('should reject when handler throws', async () => {
      const handler: TaskHandler = async () => {
        throw new Error('handler failure');
      };
      const dispatcher = new TaskDispatcher(store, handler);

      await expect(dispatcher.dispatchAndAwait('sess_1', makePayload())).rejects.toThrow(
        'handler failure',
      );
    });

    test('should reject when task is cancelled while waiting for session lock', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      const handler: TaskHandler = async (_task, _payload, signal) => {
        return new Promise<string>((resolve, reject) => {
          barriers.push({ resolve });
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      // task1 holds session lock — use catch to prevent unhandled rejection
      const task1Promise = dispatcher
        .dispatchAndAwait(
          'sess_await_cancel',
          makePayload({ message: makeMessage({ id: 'aw_msg_1' }) }),
        )
        .catch(() => 'task1-rejected');
      await vi_wait(() => barriers.length > 0);

      // task2 queues behind task1's session lock
      const task2Promise = dispatcher.dispatchAndAwait(
        'sess_await_cancel',
        makePayload({ message: makeMessage({ id: 'aw_msg_2' }) }),
      );

      // Cancel all tasks in the session — both get aborted
      dispatcher.cancelBySession('sess_await_cancel');

      // Allow task1's handler to process the abort (resolve the barrier so finally runs)
      barriers[0].resolve('done');

      // task1 was aborted, so it rejects — but we caught it above
      const task1Result = await task1Promise;
      expect(task1Result).toBe('task1-rejected');

      // task2 should also reject (cancelled while waiting for lock)
      await expect(task2Promise).rejects.toThrow();
    });

    test('should return correct result when task is queued behind another', async () => {
      const barriers: Array<{ resolve: (v: string) => void }> = [];
      let callCount = 0;

      const handler: TaskHandler = async () => {
        callCount++;
        const myCall = callCount;
        return new Promise<string>((resolve) => {
          barriers.push({ resolve: () => resolve(`result_${myCall}`) });
        });
      };

      const dispatcher = new TaskDispatcher(store, handler, { concurrency: 4 });

      // Two tasks in the same session — task2 must wait for task1
      const p1 = dispatcher.dispatchAndAwait(
        'sess_queue',
        makePayload({ message: makeMessage({ id: 'q_msg_1' }) }),
      );
      const p2 = dispatcher.dispatchAndAwait(
        'sess_queue',
        makePayload({ message: makeMessage({ id: 'q_msg_2' }) }),
      );

      await vi_wait(() => barriers.length >= 1);
      barriers[0].resolve('');

      await vi_wait(() => barriers.length >= 2);
      barriers[1].resolve('');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.result).toBe('result_1');
      expect(r2.result).toBe('result_2');
    });
  });

  describe('execution mode passthrough', () => {
    test('should store executionMode from payload', async () => {
      const handler: TaskHandler = async () => 'done';
      const dispatcher = new TaskDispatcher(store, handler);

      const taskId = await dispatcher.dispatch(
        'sess_1',
        makePayload({ executionMode: 'long-horizon' }),
      );

      const row = db.prepare('SELECT execution_mode FROM tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(row.execution_mode).toBe('long-horizon');
    });

    test('should default to sync when not specified', async () => {
      const handler: TaskHandler = async () => 'done';
      const dispatcher = new TaskDispatcher(store, handler);

      const taskId = await dispatcher.dispatch('sess_1', makePayload());

      const row = db.prepare('SELECT execution_mode FROM tasks WHERE id = ?').get(taskId) as Record<
        string,
        unknown
      >;
      expect(row.execution_mode).toBe('sync');
    });
  });
});

// ── Utility ──

/**
 * Poll until condition is true, with timeout.
 */
async function vi_wait(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('vi_wait timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
