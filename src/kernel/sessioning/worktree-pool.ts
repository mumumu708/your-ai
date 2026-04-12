import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../../shared/logging/logger';
import { BunGitOperations, type GitOperations } from './git-operations';

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_BASE_PATH = join(process.cwd(), '.worktrees');

export interface WorktreeSlot {
  id: string;
  branch: string;
  worktreePath: string;
  taskId: string;
  createdAt: number;
}

export interface WorktreePoolConfig {
  maxConcurrent?: number;
  basePath?: string;
  timeoutMs?: number;
  gitOps?: GitOperations;
  baseBranch?: string;
}

export class WorktreePool {
  private readonly logger = new Logger('WorktreePool');
  private readonly maxConcurrent: number;
  private readonly basePath: string;
  private readonly timeoutMs: number;
  private readonly gitOps: GitOperations;
  private readonly baseBranch: string;
  private readonly slots: Map<string, WorktreeSlot> = new Map();
  private readonly waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(config: WorktreePoolConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.basePath = config.basePath ?? DEFAULT_BASE_PATH;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.gitOps = config.gitOps ?? new BunGitOperations();
    this.baseBranch = config.baseBranch ?? 'main';
  }

  async run<T>(
    taskId: string,
    branchName: string,
    fn: (slot: WorktreeSlot) => Promise<T>,
  ): Promise<T> {
    const slot = await this.acquire(taskId, branchName);
    try {
      return await fn(slot);
    } finally {
      await this.release(slot.id);
    }
  }

  async acquire(taskId: string, branchName: string): Promise<WorktreeSlot> {
    if (this.slots.size >= this.maxConcurrent) {
      await this.waitForSlot();
    }

    const id = `harness-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const worktreePath = join(this.basePath, id);

    // Reserve slot synchronously before async git call to prevent race conditions
    const slot: WorktreeSlot = {
      id,
      branch: branchName,
      worktreePath,
      taskId,
      createdAt: Date.now(),
    };
    this.slots.set(id, slot);

    try {
      await this.gitOps.addWorktree(worktreePath, branchName, this.baseBranch);
    } catch (err) {
      // Roll back reservation on failure
      this.slots.delete(id);
      if (this.waiters.length > 0) {
        const next = this.waiters.shift()!;
        next.resolve();
      }
      throw err;
    }

    this.logger.info('Slot 已分配', {
      slotId: id,
      taskId,
      branch: branchName,
      activeCount: this.slots.size,
    });

    return slot;
  }

  async release(slotId: string): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) {
      this.logger.warn('释放不存在的 slot', { slotId });
      return;
    }

    try {
      await this.gitOps.removeWorktree(slot.worktreePath);
    } catch (err) {
      this.logger.warn('Worktree 清理失败，跳过', {
        slotId,
        worktreePath: slot.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.slots.delete(slotId);

    this.logger.info('Slot 已释放', {
      slotId,
      activeCount: this.slots.size,
      waitingCount: this.waiters.length,
    });

    // Wake next waiter
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.resolve();
    }
  }

  getActiveCount(): number {
    return this.slots.size;
  }

  getWaitingCount(): number {
    return this.waiters.length;
  }

  cleanupStale(): void {
    if (!existsSync(this.basePath)) {
      return;
    }

    try {
      const entries = readdirSync(this.basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('harness-')) {
          const worktreePath = join(this.basePath, entry.name);
          // Fire-and-forget cleanup
          this.gitOps.removeWorktree(worktreePath).catch((err) => {
            this.logger.warn('残留 worktree 清理失败', {
              worktreePath,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    } catch (err) {
      this.logger.warn('扫描残留 worktree 失败', {
        basePath: this.basePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        waiter.reject(new Error('WorktreePool 等待超时'));
      }, this.timeoutMs);

      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      this.waiters.push(waiter);
    });
  }

  private removeWaiter(waiter: { resolve: () => void; reject: (err: Error) => void }): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) {
      this.waiters.splice(idx, 1);
    }
  }
}
