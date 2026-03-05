import { describe, expect, test } from 'bun:test';
import { ERROR_CODES } from './error-codes';
import { YourBotError } from './yourbot-error';

describe('YourBotError', () => {
  test('应该使用正确的 code、message 和 context 创建错误实例', () => {
    const context = { userId: 'user_001', action: 'login' };
    const error = new YourBotError(ERROR_CODES.AUTH_FAILED, '认证失败', context);

    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toBe('认证失败');
    expect(error.context).toEqual(context);
  });

  test('应该将 name 属性设置为 YourBotError', () => {
    const error = new YourBotError(ERROR_CODES.UNKNOWN, 'test');

    expect(error.name).toBe('YourBotError');
  });

  test('应该在创建时记录时间戳', () => {
    const before = Date.now();
    const error = new YourBotError(ERROR_CODES.TIMEOUT, 'timeout');
    const after = Date.now();

    expect(error.timestamp).toBeGreaterThanOrEqual(before);
    expect(error.timestamp).toBeLessThanOrEqual(after);
  });

  test('应该通过 toJSON 正确序列化', () => {
    const error = new YourBotError(ERROR_CODES.TASK_FAILED, '任务失败', { taskId: 't1' });
    const json = error.toJSON();

    expect(json).toEqual({
      name: 'YourBotError',
      code: 'TASK_FAILED',
      message: '任务失败',
      timestamp: error.timestamp,
      context: { taskId: 't1' },
    });
  });

  test('应该在未提供 context 时默认为空对象', () => {
    const error = new YourBotError(ERROR_CODES.UNKNOWN, 'no context');

    expect(error.context).toEqual({});
  });

  test('应该是 Error 的实例', () => {
    const error = new YourBotError(ERROR_CODES.UNKNOWN, 'test');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(YourBotError);
  });
});
