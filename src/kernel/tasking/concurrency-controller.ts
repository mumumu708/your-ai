import { Logger } from '../../shared/logging/logger';

export interface ConcurrencyConfig {
  globalSlots?: number;
  perUserSlots?: number;
}

const DEFAULT_GLOBAL_SLOTS = 25;
const DEFAULT_PER_USER_SLOTS = 3;

export class ConcurrencyController {
  private readonly logger = new Logger('ConcurrencyController');
  private readonly globalSlots: number;
  private readonly perUserSlots: number;
  private activeGlobal = 0;
  private readonly activePerUser = new Map<string, number>();
  private readonly waiters: Array<{ userId: string; resolve: () => void }> = [];

  constructor(config: ConcurrencyConfig = {}) {
    this.globalSlots = config.globalSlots ?? DEFAULT_GLOBAL_SLOTS;
    this.perUserSlots = config.perUserSlots ?? DEFAULT_PER_USER_SLOTS;
  }

  /**
   * Acquire a concurrency slot. Resolves when a slot is available.
   */
  async acquire(userId: string): Promise<void> {
    if (this.canAcquire(userId)) {
      this.doAcquire(userId);
      return;
    }

    // Wait for a slot to become available
    return new Promise<void>((resolve) => {
      this.waiters.push({ userId, resolve });
    });
  }

  /**
   * Try to acquire a slot without waiting. Returns false if no slot is available.
   */
  tryAcquire(userId: string): boolean {
    if (!this.canAcquire(userId)) return false;
    this.doAcquire(userId);
    return true;
  }

  /**
   * Release a concurrency slot.
   */
  release(userId: string): void {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    const userCount = this.activePerUser.get(userId) ?? 0;
    if (userCount > 0) {
      this.activePerUser.set(userId, userCount - 1);
    }

    // Wake up waiting tasks
    this.processWaiters();
  }

  getActiveGlobal(): number {
    return this.activeGlobal;
  }

  getActiveForUser(userId: string): number {
    return this.activePerUser.get(userId) ?? 0;
  }

  getWaiterCount(): number {
    return this.waiters.length;
  }

  private canAcquire(userId: string): boolean {
    return (
      this.activeGlobal < this.globalSlots &&
      (this.activePerUser.get(userId) ?? 0) < this.perUserSlots
    );
  }

  private doAcquire(userId: string): void {
    this.activeGlobal++;
    this.activePerUser.set(userId, (this.activePerUser.get(userId) ?? 0) + 1);
  }

  private processWaiters(): void {
    let i = 0;
    while (i < this.waiters.length) {
      const waiter = this.waiters[i];
      if (!waiter) {
        i++;
        continue;
      }
      if (this.canAcquire(waiter.userId)) {
        this.doAcquire(waiter.userId);
        this.waiters.splice(i, 1);
        waiter.resolve();
      } else {
        i++;
      }
    }
  }
}
