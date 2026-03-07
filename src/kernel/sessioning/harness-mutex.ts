import { Logger } from '../../shared/logging/logger';

export interface HarnessMutexConfig {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_600_000; // 1 hour

export class HarnessMutex {
  private readonly logger = new Logger('HarnessMutex');
  private readonly timeoutMs: number;
  private locked = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(config: HarnessMutexConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  getWaiterCount(): number {
    return this.waiters.length;
  }

  private async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error('HarnessMutex 超时'));
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

  private release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  private removeWaiter(waiter: { resolve: () => void; reject: (err: Error) => void }): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) {
      this.waiters.splice(idx, 1);
    }
  }
}
