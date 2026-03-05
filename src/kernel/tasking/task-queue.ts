import { Logger } from '../../shared/logging/logger';
import type { TaskResult } from '../../shared/tasking/task-result.types';
import type { Task } from '../../shared/tasking/task.types';
import { type ConcurrencyConfig, ConcurrencyController } from './concurrency-controller';

// --- Types ---

export interface TaskQueueConfig {
  concurrency?: ConcurrencyConfig;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export type TaskHandler = (task: Task) => Promise<TaskResult>;

interface QueueEntry {
  task: Task;
  retryCount: number;
  enqueuedAt: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 5000;

// --- TaskQueue ---

export class TaskQueue {
  private readonly logger = new Logger('TaskQueue');
  private readonly pending: QueueEntry[] = [];
  private readonly concurrency: ConcurrencyController;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private handler: TaskHandler | null = null;
  private processing = false;

  constructor(config: TaskQueueConfig = {}) {
    this.concurrency = new ConcurrencyController(config.concurrency);
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  /**
   * Set the task handler that will process dequeued tasks.
   */
  setHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  /**
   * Enqueue a task for processing.
   * If no handler is set, returns an immediate success result (backward compatible).
   */
  async enqueue(task: Task): Promise<TaskResult> {
    this.logger.info('任务入队', { taskId: task.id, type: task.type });

    if (!this.handler) {
      // Backward compatible: no handler = immediate success
      this.pending.push({ task, retryCount: 0, enqueuedAt: Date.now() });
      return {
        success: true,
        taskId: task.id,
        completedAt: Date.now(),
      };
    }

    const entry: QueueEntry = { task, retryCount: 0, enqueuedAt: Date.now() };
    this.pending.push(entry);

    // Process inline if possible
    return this.processEntry(entry);
  }

  /**
   * Get the current queue depth (pending items).
   */
  getQueueDepth(): number {
    return this.pending.length;
  }

  getActiveCount(): number {
    return this.concurrency.getActiveGlobal();
  }

  // --- Private ---

  private async processEntry(entry: QueueEntry): Promise<TaskResult> {
    const { task } = entry;
    const userId = task.metadata?.userId ?? task.message.userId;

    // Acquire concurrency slot
    await this.concurrency.acquire(userId);

    try {
      const result = await this.executeWithRetry(entry);
      return result;
    } finally {
      this.concurrency.release(userId);
      // Remove from pending
      const idx = this.pending.indexOf(entry);
      if (idx >= 0) this.pending.splice(idx, 1);
    }
  }

  private async executeWithRetry(entry: QueueEntry): Promise<TaskResult> {
    const { task } = entry;

    while (entry.retryCount <= this.maxRetries) {
      try {
        const result = await this.handler?.(task);
        return result;
      } catch (error) {
        entry.retryCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (entry.retryCount > this.maxRetries) {
          this.logger.error('任务重试耗尽', {
            taskId: task.id,
            retries: entry.retryCount - 1,
            error: errorMsg,
          });
          return {
            success: false,
            taskId: task.id,
            error: `Failed after ${this.maxRetries} retries: ${errorMsg}`,
            completedAt: Date.now(),
          };
        }

        const delay = this.calculateRetryDelay(entry.retryCount);
        this.logger.info('任务重试', {
          taskId: task.id,
          retry: entry.retryCount,
          delayMs: delay,
        });

        await this.sleep(delay);
      }
    }

    // Should not reach here
    return {
      success: false,
      taskId: task.id,
      error: 'Unexpected retry loop exit',
      completedAt: Date.now(),
    };
  }

  /**
   * Exponential backoff: base * 2^(attempt-1)
   */
  calculateRetryDelay(attempt: number): number {
    return this.retryBaseDelayMs * 2 ** (attempt - 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
