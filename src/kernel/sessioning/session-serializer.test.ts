import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SessionSerializer } from './session-serializer';

describe('SessionSerializer', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('空闲时应该立即执行', async () => {
    const serializer = new SessionSerializer();
    const result = await serializer.run('session-1', async () => 42);
    expect(result).toBe(42);
  });

  test('同一 session 应该串行执行', async () => {
    const serializer = new SessionSerializer();
    const order: number[] = [];

    const p1 = serializer.run('session-1', async () => {
      await delay(50);
      order.push(1);
    });

    const p2 = serializer.run('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test('不同 session 应该并行执行', async () => {
    const serializer = new SessionSerializer();
    const order: string[] = [];

    const p1 = serializer.run('session-1', async () => {
      await delay(50);
      order.push('a-end');
    });

    const p2 = serializer.run('session-2', async () => {
      order.push('b-end');
    });

    await Promise.all([p1, p2]);
    // session-2 should finish before session-1 since they run in parallel
    expect(order).toEqual(['b-end', 'a-end']);
  });

  test('应该保证 FIFO 顺序', async () => {
    const serializer = new SessionSerializer();
    const order: number[] = [];

    const p1 = serializer.run('session-1', async () => {
      await delay(30);
      order.push(1);
    });

    // Queue up multiple tasks
    const p2 = serializer.run('session-1', async () => {
      order.push(2);
    });

    const p3 = serializer.run('session-1', async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('异常时应该释放锁', async () => {
    const serializer = new SessionSerializer();

    try {
      await serializer.run('session-1', async () => {
        throw new Error('test error');
      });
    } catch {
      // expected
    }

    // Should be able to run again after error
    const result = await serializer.run('session-1', async () => 'ok');
    expect(result).toBe('ok');
  });

  test('超时应该拒绝等待中的任务', async () => {
    const serializer = new SessionSerializer({ timeoutMs: 50 });

    // Hold the lock for longer than timeout
    const p1 = serializer.run('session-1', async () => {
      await delay(200);
    });

    // This should time out
    const p2 = serializer.run('session-1', async () => 'should-not-run');

    const result = await Promise.allSettled([p1, p2]);
    expect(result[0]!.status).toBe('fulfilled');
    expect(result[1]!.status).toBe('rejected');
  });

  test('getQueueDepth 应该返回等待队列深度', async () => {
    const serializer = new SessionSerializer();
    expect(serializer.getQueueDepth('session-1')).toBe(0);

    const p1 = serializer.run('session-1', async () => {
      await delay(50);
    });

    // Allow microtask to process
    await delay(1);

    serializer.run('session-1', async () => {});
    await delay(1);

    expect(serializer.getQueueDepth('session-1')).toBe(1);

    await p1;
    // Let remaining task complete
    await delay(10);
  });

  test('getActiveCount 应该返回活跃 session 数', async () => {
    const serializer = new SessionSerializer();
    expect(serializer.getActiveCount()).toBe(0);

    const p1 = serializer.run('session-1', async () => {
      await delay(50);
    });

    await delay(1);
    expect(serializer.getActiveCount()).toBe(1);

    const p2 = serializer.run('session-2', async () => {
      await delay(50);
    });

    await delay(1);
    expect(serializer.getActiveCount()).toBe(2);

    await Promise.all([p1, p2]);
    expect(serializer.getActiveCount()).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
