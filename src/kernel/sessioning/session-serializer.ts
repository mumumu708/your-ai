import { Logger } from '../../shared/logging/logger';

export interface SessionSerializerConfig {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

export class SessionSerializer {
  private readonly logger = new Logger('SessionSerializer');
  private readonly timeoutMs: number;
  private readonly queues = new Map<
    string,
    Array<{ resolve: () => void; reject: (err: Error) => void }>
  >();
  private readonly active = new Set<string>();

  constructor(config: SessionSerializerConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(sessionKey);
    try {
      return await fn();
    } finally {
      this.release(sessionKey);
    }
  }

  getQueueDepth(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  getActiveCount(): number {
    return this.active.size;
  }

  private async acquire(sessionKey: string): Promise<void> {
    if (!this.active.has(sessionKey)) {
      this.active.add(sessionKey);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(sessionKey, waiter);
        waiter.reject(new Error(`SessionSerializer 超时: key=${sessionKey}`));
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

      let queue = this.queues.get(sessionKey);
      if (!queue) {
        queue = [];
        this.queues.set(sessionKey, queue);
      }
      queue.push(waiter);
    });
  }

  private release(sessionKey: string): void {
    const queue = this.queues.get(sessionKey);

    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(sessionKey);
      }
      next.resolve();
    } else {
      this.active.delete(sessionKey);
      this.queues.delete(sessionKey);
    }
  }

  private removeWaiter(
    sessionKey: string,
    waiter: { resolve: () => void; reject: (err: Error) => void },
  ): void {
    const queue = this.queues.get(sessionKey);
    if (!queue) return;
    const idx = queue.indexOf(waiter);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
    if (queue.length === 0) {
      this.queues.delete(sessionKey);
    }
  }
}
