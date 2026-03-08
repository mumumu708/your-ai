import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Task } from '../../shared/tasking/task.types';
import { TaskQueue } from './task-queue';

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_test_001',
    traceId: 'trace_test_001',
    type: 'chat',
    message: {
      id: 'msg_001',
      channel: 'web',
      userId: 'user_001',
      userName: 'Test',
      conversationId: 'conv_001',
      content: 'hello',
      contentType: 'text',
      timestamp: Date.now(),
      metadata: {},
    },
    session: {
      id: 'sess_001',
      userId: 'user_001',
      channel: 'web',
      conversationId: 'conv_001',
      status: 'active',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      agentConfig: { maxContextTokens: 100000 },
      messages: [],
    },
    priority: 5,
    createdAt: Date.now(),
    metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
    ...overrides,
  };
}

describe('TaskQueue', () => {
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

  describe('backward compatibility (no handler)', () => {
    test('应该入队任务并返回成功结果', async () => {
      const queue = new TaskQueue();
      const task = createMockTask();
      const result = await queue.enqueue(task);

      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task_test_001');
      expect(result.completedAt).toBeGreaterThan(0);
    });

    test('应该正确追踪队列深度', async () => {
      const queue = new TaskQueue();
      expect(queue.getQueueDepth()).toBe(0);

      await queue.enqueue(createMockTask({ id: 'task_001' }));
      expect(queue.getQueueDepth()).toBe(1);

      await queue.enqueue(createMockTask({ id: 'task_002' }));
      expect(queue.getQueueDepth()).toBe(2);
    });

    test('应该在结果中包含正确的 taskId', async () => {
      const queue = new TaskQueue();
      const task = createMockTask({ id: 'task_custom_id' });
      const result = await queue.enqueue(task);

      expect(result.taskId).toBe('task_custom_id');
    });
  });

  describe('with handler', () => {
    test('应该通过 handler 处理任务', async () => {
      const processed: string[] = [];
      const queue = new TaskQueue();
      queue.setHandler(async (task) => {
        processed.push(task.id);
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const result = await queue.enqueue(createMockTask({ id: 'task_handled' }));
      expect(result.success).toBe(true);
      expect(processed).toContain('task_handled');
    });

    test('handler 失败应该重试', async () => {
      let attempts = 0;
      const queue = new TaskQueue({
        maxRetries: 2,
        retryBaseDelayMs: 10, // Fast for tests
      });
      queue.setHandler(async (task) => {
        attempts++;
        if (attempts < 3) throw new Error('Temporary failure');
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const result = await queue.enqueue(createMockTask());
      expect(result.success).toBe(true);
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    test('重试耗尽应该返回失败', async () => {
      const queue = new TaskQueue({
        maxRetries: 1,
        retryBaseDelayMs: 10,
      });
      queue.setHandler(async () => {
        throw new Error('Permanent failure');
      });

      const result = await queue.enqueue(createMockTask());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed after 1 retries');
    });
  });

  describe('getActiveCount', () => {
    test('应该返回当前活跃的任务数', async () => {
      const queue = new TaskQueue();
      expect(queue.getActiveCount()).toBe(0);

      queue.setHandler(async (task) => {
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const p = queue.enqueue(createMockTask());
      await new Promise((r) => setTimeout(r, 10));
      expect(queue.getActiveCount()).toBeGreaterThanOrEqual(1);
      await p;
    });
  });

  describe('calculateRetryDelay', () => {
    test('应该使用指数退避', () => {
      const queue = new TaskQueue({ retryBaseDelayMs: 5000 });
      expect(queue.calculateRetryDelay(1)).toBe(5000); // 5s * 2^0
      expect(queue.calculateRetryDelay(2)).toBe(10000); // 5s * 2^1
      expect(queue.calculateRetryDelay(3)).toBe(20000); // 5s * 2^2
    });
  });
});
