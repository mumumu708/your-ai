import { describe, expect, test } from 'bun:test';
import { ConcurrencyController } from './concurrency-controller';

describe('ConcurrencyController', () => {
  test('应该允许获取可用的插槽', () => {
    const cc = new ConcurrencyController({ globalSlots: 5, perUserSlots: 2 });
    expect(cc.tryAcquire('user_A')).toBe(true);
    expect(cc.getActiveGlobal()).toBe(1);
    expect(cc.getActiveForUser('user_A')).toBe(1);
  });

  test('应该在用户达到上限时拒绝', () => {
    const cc = new ConcurrencyController({ globalSlots: 10, perUserSlots: 2 });
    cc.tryAcquire('user_A');
    cc.tryAcquire('user_A');
    expect(cc.tryAcquire('user_A')).toBe(false); // Hit per-user limit
    expect(cc.getActiveForUser('user_A')).toBe(2);
  });

  test('应该在全局达到上限时拒绝', () => {
    const cc = new ConcurrencyController({ globalSlots: 2, perUserSlots: 5 });
    cc.tryAcquire('user_A');
    cc.tryAcquire('user_B');
    expect(cc.tryAcquire('user_C')).toBe(false); // Hit global limit
    expect(cc.getActiveGlobal()).toBe(2);
  });

  test('释放后应该允许新的获取', () => {
    const cc = new ConcurrencyController({ globalSlots: 1, perUserSlots: 1 });
    cc.tryAcquire('user_A');
    expect(cc.tryAcquire('user_B')).toBe(false);

    cc.release('user_A');
    expect(cc.tryAcquire('user_B')).toBe(true);
  });

  test('async acquire 应该在有空位时解决等待', async () => {
    const cc = new ConcurrencyController({ globalSlots: 1, perUserSlots: 1 });
    cc.tryAcquire('user_A');

    let resolved = false;
    const waitPromise = cc.acquire('user_B').then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    expect(cc.getWaiterCount()).toBe(1);

    cc.release('user_A');
    await waitPromise;
    expect(resolved).toBe(true);
    expect(cc.getWaiterCount()).toBe(0);
  });

  test('释放不存在的用户应该安全处理', () => {
    const cc = new ConcurrencyController();
    cc.release('nonexistent'); // Should not throw
    expect(cc.getActiveGlobal()).toBe(0);
  });
});
