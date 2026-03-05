import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { McpServerLogger, withLogging } from './mcp-server-logger';

const TEST_LOG_DIR = join(import.meta.dir, '__test_logs__');

describe('McpServerLogger', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true });
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
    errorSpy.mockRestore();
  });

  test('应该创建日志文件并写入 JSONL 格式', async () => {
    const logger = new McpServerLogger('test-server', TEST_LOG_DIR);

    logger.logToolExecution({
      timestamp: '2024-01-01T00:00:00.000Z',
      level: 'info',
      serverId: 'test-server',
      toolName: 'test_tool',
      userId: 'user_001',
      traceId: 'trace_001',
      durationMs: 100,
      input: { key: 'value' },
    });

    logger.close();

    // Wait for write to flush
    await new Promise(r => setTimeout(r, 50));

    const logPath = join(TEST_LOG_DIR, 'test-server.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.toolName).toBe('test_tool');
    expect(parsed.durationMs).toBe(100);
  });

  test('error 级别应该同时输出到 stderr', () => {
    const logger = new McpServerLogger('test-server', TEST_LOG_DIR);

    logger.logToolExecution({
      timestamp: '2024-01-01T00:00:00.000Z',
      level: 'error',
      serverId: 'test-server',
      toolName: 'fail_tool',
      userId: 'user_001',
      traceId: 'trace_002',
      durationMs: 50,
      input: {},
      error: 'Something went wrong',
    });

    logger.close();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withLogging', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true });
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
    errorSpy.mockRestore();
  });

  test('应该包装成功的工具调用', async () => {
    const logger = new McpServerLogger('test-server', TEST_LOG_DIR);
    const handler = async (input: { name: string }) => ({ greeting: `Hello ${input.name}` });
    const wrapped = withLogging(logger, 'test-server', 'greet', handler);

    const result = await wrapped({ name: 'World' });
    expect(result.greeting).toBe('Hello World');

    logger.close();
  });

  test('应该记录并重新抛出错误', async () => {
    const logger = new McpServerLogger('test-server', TEST_LOG_DIR);
    const handler = async () => { throw new Error('boom'); };
    const wrapped = withLogging(logger, 'test-server', 'fail', handler);

    try {
      await wrapped({});
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe('boom');
    }

    logger.close();
  });
});
