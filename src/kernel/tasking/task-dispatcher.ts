import { Logger } from '../../shared/logging/logger';
import type { TaskPayload, TaskRecord } from '../../shared/tasking/task.types';
import type { TaskStore } from './task-store';

export type TaskHandler = (
  task: TaskRecord,
  payload: TaskPayload,
  signal: AbortSignal,
) => Promise<string>;

interface QueueItem {
  sessionId: string;
  task: TaskRecord;
  payload: TaskPayload;
}

export class TaskDispatcher {
  private readonly logger = new Logger('TaskDispatcher');
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly runningTasks = new Map<string, { task: TaskRecord; abort: AbortController }>();
  private readonly waitingTasks = new Map<string, { task: TaskRecord; abort: AbortController }>();
  private pendingQueue: QueueItem[] = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly completionCallbacks = new Map<
    string,
    { resolve: (result: string) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly taskStore: TaskStore,
    private readonly handler: TaskHandler,
    config: { concurrency?: number } = {},
  ) {
    this.concurrency = config.concurrency ?? 4;
  }

  /**
   * Unified entry point: message channels and API both call this.
   */
  async dispatch(sessionId: string, payload: TaskPayload): Promise<string> {
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      userId: payload.message.userId,
      sessionId,
      type: payload.type,
      executionMode: payload.executionMode ?? 'sync',
      source: payload.source,
      status: 'pending',
      description: payload.message.content.slice(0, 200),
      inboundMessageId: payload.message.id,
      createdAt: Date.now(),
      metadata: payload.metadata,
    };
    this.taskStore.create(task);

    this.enqueue(sessionId, task, payload);

    return task.id;
  }

  /**
   * Dispatch a task and wait for it to complete, returning the handler result.
   * Use this for the main user message path where the caller needs the result to reply.
   * Use dispatch() for fire-and-forget cases (scheduler, reflection).
   */
  async dispatchAndAwait(
    sessionId: string,
    payload: TaskPayload,
  ): Promise<{ taskId: string; result: string }> {
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      userId: payload.message.userId,
      sessionId,
      type: payload.type,
      executionMode: payload.executionMode ?? 'sync',
      source: payload.source,
      status: 'pending',
      description: payload.message.content.slice(0, 200),
      inboundMessageId: payload.message.id,
      createdAt: Date.now(),
      metadata: payload.metadata,
    };
    this.taskStore.create(task);

    return new Promise<{ taskId: string; result: string }>((resolve, reject) => {
      this.completionCallbacks.set(task.id, {
        resolve: (result) => resolve({ taskId: task.id, result }),
        reject,
      });
      this.enqueue(sessionId, task, payload);
    });
  }

  private enqueue(sessionId: string, task: TaskRecord, payload: TaskPayload): void {
    if (this.running < this.concurrency) {
      this.startTask(sessionId, task, payload);
    } else {
      this.pendingQueue.push({ sessionId, task, payload });
    }
  }

  private startTask(sessionId: string, task: TaskRecord, payload: TaskPayload): void {
    this.running++;

    const abort = new AbortController();
    this.waitingTasks.set(task.id, { task, abort });

    // Session-level serial: chain after previous promise for this session
    const prevLock = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const currentLock = prevLock.then(() => {
      this.waitingTasks.delete(task.id);
      return this.executeTask(sessionId, task, payload, abort);
    });
    this.sessionLocks.set(
      sessionId,
      currentLock.catch(() => {}),
    );
  }

  private async executeTask(
    _sessionId: string,
    task: TaskRecord,
    payload: TaskPayload,
    abort: AbortController,
  ): Promise<void> {
    // Task may have been cancelled while waiting for session lock
    if (abort.signal.aborted) {
      this.taskStore.updateStatus(task.id, 'cancelled', { completedAt: Date.now() });

      const cancelCallback = this.completionCallbacks.get(task.id);
      if (cancelCallback) {
        cancelCallback.reject(new Error('Task was cancelled'));
        this.completionCallbacks.delete(task.id);
      }

      this.running--;
      this.processQueue();
      return;
    }

    this.runningTasks.set(task.id, { task, abort });

    task.status = 'running';
    task.startedAt = Date.now();
    this.taskStore.updateStatus(task.id, 'running', { startedAt: task.startedAt });

    try {
      const result = await this.handler(task, payload, abort.signal);

      task.status = 'completed';
      task.completedAt = Date.now();
      task.resultSummary = result.slice(0, 1000);
      this.taskStore.updateStatus(task.id, 'completed', {
        completedAt: task.completedAt,
        resultSummary: task.resultSummary,
      });

      const successCallback = this.completionCallbacks.get(task.id);
      if (successCallback) {
        successCallback.resolve(result);
        this.completionCallbacks.delete(task.id);
      }
    } catch (error) {
      task.completedAt = Date.now();
      if (abort.signal.aborted) {
        task.status = 'cancelled';
        this.taskStore.updateStatus(task.id, 'cancelled', { completedAt: task.completedAt });
      } else {
        task.status = 'failed';
        task.errorMessage = error instanceof Error ? error.message : String(error);
        this.taskStore.updateStatus(task.id, 'failed', {
          completedAt: task.completedAt,
          errorMessage: task.errorMessage,
        });
      }

      const failCallback = this.completionCallbacks.get(task.id);
      if (failCallback) {
        failCallback.reject(error instanceof Error ? error : new Error(String(error)));
        this.completionCallbacks.delete(task.id);
      }
    } finally {
      this.runningTasks.delete(task.id);
      this.running--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (this.running < this.concurrency && this.pendingQueue.length > 0) {
      const item = this.pendingQueue.shift();
      if (!item) break;
      this.startTask(item.sessionId, item.task, item.payload);
    }
  }

  // ── Cancel ──

  /**
   * /stop command: cancel running tasks for a session + remove pending ones.
   */
  cancelBySession(sessionId: string): number {
    let cancelled = 0;

    for (const [, { task, abort }] of this.runningTasks) {
      if (task.sessionId === sessionId) {
        abort.abort();
        cancelled++;
      }
    }

    for (const [, { task, abort }] of this.waitingTasks) {
      if (task.sessionId === sessionId) {
        abort.abort();
        cancelled++;
      }
    }

    const before = this.pendingQueue.length;
    this.pendingQueue = this.pendingQueue.filter((item) => {
      if (item.sessionId === sessionId) {
        this.taskStore.updateStatus(item.task.id, 'cancelled', { completedAt: Date.now() });
        return false;
      }
      return true;
    });
    cancelled += before - this.pendingQueue.length;

    return cancelled;
  }

  /**
   * Message recall: cancel the task associated with a specific inbound message.
   */
  cancelByMessageId(inboundMessageId: string): boolean {
    // Check pending queue first
    const idx = this.pendingQueue.findIndex(
      (item) => item.task.inboundMessageId === inboundMessageId,
    );
    if (idx >= 0) {
      const removed = this.pendingQueue.splice(idx, 1)[0] as QueueItem;
      const { task } = removed;
      this.taskStore.updateStatus(task.id, 'cancelled', { completedAt: Date.now() });
      return true;
    }

    // Check waiting-for-lock tasks
    for (const [, { task, abort }] of this.waitingTasks) {
      if (task.inboundMessageId === inboundMessageId) {
        abort.abort();
        return true;
      }
    }

    // Check running tasks
    for (const [, { task, abort }] of this.runningTasks) {
      if (task.inboundMessageId === inboundMessageId) {
        abort.abort();
        return true;
      }
    }

    return false;
  }

  // ── Query ──

  getActiveTasks(sessionId?: string): TaskRecord[] {
    if (sessionId) {
      return [...this.runningTasks.values()]
        .filter(({ task }) => task.sessionId === sessionId)
        .map(({ task }) => task);
    }
    return [...this.runningTasks.values()].map(({ task }) => task);
  }

  getRunningCount(): number {
    return this.running;
  }

  getPendingCount(): number {
    return this.pendingQueue.length;
  }

  // ── Lifecycle ──

  async shutdown(): Promise<void> {
    // Cancel all running tasks
    for (const [, { abort }] of this.runningTasks) {
      abort.abort();
    }
    // Cancel all waiting-for-lock tasks
    for (const [, { abort }] of this.waitingTasks) {
      abort.abort();
    }
    // Mark all pending as cancelled
    for (const { task } of this.pendingQueue) {
      this.taskStore.updateStatus(task.id, 'cancelled', {
        completedAt: Date.now(),
        errorMessage: 'process_shutdown',
      });
    }
    this.pendingQueue = [];

    // Wait for running tasks to finish (max 10s)
    const deadline = Date.now() + 10_000;
    while (this.runningTasks.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
