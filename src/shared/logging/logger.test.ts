import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { LOG_LEVELS } from './log-levels';
import type { LogEntry } from './logger';
import { Logger } from './logger';

describe('Logger', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    Logger.setLevel(LOG_LEVELS.DEBUG);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    Logger.setLevel(LOG_LEVELS.INFO);
  });

  function parseLogOutput(spy: ReturnType<typeof spyOn>): LogEntry {
    const call = spy.mock.calls[0];
    return JSON.parse(call?.[0] as string) as LogEntry;
  }

  test('应该将 info 级别的结构化 JSON 输出到 console.log', () => {
    const logger = new Logger('TestModule');
    logger.info('测试消息');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = parseLogOutput(logSpy);
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('测试消息');
  });

  test('应该将 error 级别的结构化 JSON 输出到 console.error', () => {
    const logger = new Logger('TestModule');
    logger.error('错误消息');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const entry = parseLogOutput(errorSpy);
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('错误消息');
  });

  test('应该将 warn 级别输出到 console.error', () => {
    const logger = new Logger('TestModule');
    logger.warn('警告消息');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const entry = parseLogOutput(errorSpy);
    expect(entry.level).toBe('warn');
  });

  test('应该在日志输出中包含模块名称', () => {
    const logger = new Logger('MyModule');
    logger.info('test');

    const entry = parseLogOutput(logSpy);
    expect(entry.module).toBe('MyModule');
  });

  test('应该包含 ISO 格式的时间戳', () => {
    const logger = new Logger('TestModule');
    logger.info('test');

    const entry = parseLogOutput(logSpy);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('应该将 context 字段合并到日志条目中', () => {
    const logger = new Logger('TestModule');
    logger.info('test', { traceId: 'trace_001', userId: 'user_001' });

    const entry = parseLogOutput(logSpy);
    expect(entry.traceId).toBe('trace_001');
    expect(entry.userId).toBe('user_001');
  });

  test('应该在级别为 info 时抑制 debug 日志', () => {
    Logger.setLevel(LOG_LEVELS.INFO);
    const logger = new Logger('TestModule');
    logger.debug('debug message');

    expect(logSpy).not.toHaveBeenCalled();
  });

  test('应该允许通过 setLevel 更改全局日志级别', () => {
    Logger.setLevel(LOG_LEVELS.ERROR);
    expect(Logger.getLevel()).toBe('error');

    const logger = new Logger('TestModule');
    logger.info('should not appear');
    logger.warn('should not appear');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logger.error('should appear');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('应该在未提供 context 时正常处理', () => {
    const logger = new Logger('TestModule');
    logger.info('no context');

    const entry = parseLogOutput(logSpy);
    expect(entry.message).toBe('no context');
    expect(entry.module).toBe('TestModule');
  });

  test('应该将 debug 级别输出到 console.log', () => {
    const logger = new Logger('TestModule');
    logger.debug('debug message');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = parseLogOutput(logSpy);
    expect(entry.level).toBe('debug');
  });
});
