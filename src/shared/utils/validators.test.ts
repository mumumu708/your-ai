import { describe, expect, test } from 'bun:test';
import { isNonEmptyString, isValidBotMessage } from './validators';

describe('isValidBotMessage', () => {
  test('应该对有效的 BotMessage 对象返回 true', () => {
    const message = {
      id: 'msg_001',
      channel: 'web',
      userId: 'user_001',
      userName: 'Test User',
      conversationId: 'conv_001',
      content: 'Hello',
      contentType: 'text',
      timestamp: Date.now(),
      metadata: {},
    };
    expect(isValidBotMessage(message)).toBe(true);
  });

  test('应该对 null 返回 false', () => {
    expect(isValidBotMessage(null)).toBe(false);
  });

  test('应该对缺少必填字段的对象返回 false', () => {
    expect(isValidBotMessage({ id: 'msg_001' })).toBe(false);
  });

  test('应该对非对象类型返回 false', () => {
    expect(isValidBotMessage('string')).toBe(false);
    expect(isValidBotMessage(123)).toBe(false);
    expect(isValidBotMessage(undefined)).toBe(false);
  });
});

describe('isNonEmptyString', () => {
  test('应该对非空字符串返回 true', () => {
    expect(isNonEmptyString('hello')).toBe(true);
  });

  test('应该对空字符串返回 false', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  test('应该对非字符串类型返回 false', () => {
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
  });
});
