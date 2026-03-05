import { describe, expect, test } from 'bun:test';
import { isExpired, nowMs, withTimeout } from './time';

describe('nowMs', () => {
  test('应该返回当前时间戳（毫秒）', () => {
    const before = Date.now();
    const result = nowMs();
    const after = Date.now();

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

describe('isExpired', () => {
  test('应该正确识别已过期的时间戳', () => {
    const pastTimestamp = Date.now() - 10000;
    expect(isExpired(pastTimestamp, 5000)).toBe(true);
  });

  test('应该正确识别未过期的时间戳', () => {
    const recentTimestamp = Date.now() - 1000;
    expect(isExpired(recentTimestamp, 5000)).toBe(false);
  });
});

describe('withTimeout', () => {
  test('应该在 promise 在超时前完成时正常 resolve', async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 10);
    });
    const result = await withTimeout(promise, 1000);
    expect(result).toBe('done');
  });

  test('应该在 promise 超时时 reject', async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 5000);
    });

    expect(withTimeout(promise, 10)).rejects.toThrow('Operation timed out');
  });

  test('应该使用自定义错误消息', async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 5000);
    });

    expect(withTimeout(promise, 10, '自定义超时')).rejects.toThrow('自定义超时');
  });
});
