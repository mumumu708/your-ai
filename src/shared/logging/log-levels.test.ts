import { describe, expect, test } from 'bun:test';
import { LOG_LEVELS, isLevelEnabled } from './log-levels';

describe('LOG_LEVELS', () => {
  test('应该定义四个日志级别', () => {
    expect(LOG_LEVELS.DEBUG).toBe('debug');
    expect(LOG_LEVELS.INFO).toBe('info');
    expect(LOG_LEVELS.WARN).toBe('warn');
    expect(LOG_LEVELS.ERROR).toBe('error');
  });
});

describe('isLevelEnabled', () => {
  test('应该在阈值为 debug 时启用所有级别', () => {
    expect(isLevelEnabled('debug', 'debug')).toBe(true);
    expect(isLevelEnabled('info', 'debug')).toBe(true);
    expect(isLevelEnabled('warn', 'debug')).toBe(true);
    expect(isLevelEnabled('error', 'debug')).toBe(true);
  });

  test('应该在阈值为 info 时禁用 debug', () => {
    expect(isLevelEnabled('debug', 'info')).toBe(false);
    expect(isLevelEnabled('info', 'info')).toBe(true);
    expect(isLevelEnabled('warn', 'info')).toBe(true);
    expect(isLevelEnabled('error', 'info')).toBe(true);
  });

  test('应该在阈值为 warn 时禁用 debug 和 info', () => {
    expect(isLevelEnabled('debug', 'warn')).toBe(false);
    expect(isLevelEnabled('info', 'warn')).toBe(false);
    expect(isLevelEnabled('warn', 'warn')).toBe(true);
    expect(isLevelEnabled('error', 'warn')).toBe(true);
  });

  test('应该在阈值为 error 时仅启用 error', () => {
    expect(isLevelEnabled('debug', 'error')).toBe(false);
    expect(isLevelEnabled('info', 'error')).toBe(false);
    expect(isLevelEnabled('warn', 'error')).toBe(false);
    expect(isLevelEnabled('error', 'error')).toBe(true);
  });
});
