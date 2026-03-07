import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { HarnessMutex } from './harness-mutex';

describe('HarnessMutex', () => {
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

  test('无锁时应该立即执行', async () => {
    const mutex = new HarnessMutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  test('应该互斥等待', async () => {
    const mutex = new HarnessMutex();
    const order: number[] = [];

    const p1 = mutex.run(async () => {
      await delay(50);
      order.push(1);
    });

    const p2 = mutex.run(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test('异常时应该释放锁', async () => {
    const mutex = new HarnessMutex();

    try {
      await mutex.run(async () => {
        throw new Error('test error');
      });
    } catch {
      // expected
    }

    expect(mutex.isLocked()).toBe(false);

    const result = await mutex.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  test('超时应该拒绝等待中的任务', async () => {
    const mutex = new HarnessMutex({ timeoutMs: 50 });

    const p1 = mutex.run(async () => {
      await delay(200);
    });

    const p2 = mutex.run(async () => 'should-not-run');

    const result = await Promise.allSettled([p1, p2]);
    expect(result[0]!.status).toBe('fulfilled');
    expect(result[1]!.status).toBe('rejected');
  });

  test('应该保证 FIFO 顺序', async () => {
    const mutex = new HarnessMutex();
    const order: number[] = [];

    const p1 = mutex.run(async () => {
      await delay(30);
      order.push(1);
    });

    const p2 = mutex.run(async () => {
      order.push(2);
    });

    const p3 = mutex.run(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('isLocked 应该反映锁状态', async () => {
    const mutex = new HarnessMutex();
    expect(mutex.isLocked()).toBe(false);

    const p = mutex.run(async () => {
      await delay(50);
    });

    await delay(1);
    expect(mutex.isLocked()).toBe(true);

    await p;
    expect(mutex.isLocked()).toBe(false);
  });

  test('getWaiterCount 应该返回等待数', async () => {
    const mutex = new HarnessMutex();
    expect(mutex.getWaiterCount()).toBe(0);

    const p1 = mutex.run(async () => {
      await delay(50);
    });

    await delay(1);

    mutex.run(async () => {});
    await delay(1);

    expect(mutex.getWaiterCount()).toBe(1);

    await p1;
    await delay(10);
    expect(mutex.getWaiterCount()).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
