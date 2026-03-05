/**
 * 集成测试: 任务队列管道
 *
 * 测试完整的自动化任务流程:
 *   BotMessage → classifyIntent('automation') → handleAutomationTask → TaskQueue.enqueue
 *   → ConcurrencyController 并发控制 → handler 执行 → 重试机制
 *
 * 所有 LLM 后端均使用 mock，不产生真实 API 调用。
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { AgentBridgeResult, ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import type { LightLLMClient } from '../kernel/agents/light-llm-client';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { TaskQueue } from '../kernel/tasking/task-queue';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import type { Task } from '../shared/tasking/task.types';

// ── Test helpers ──────────────────────────────────────────

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}`,
    channel: 'web',
    userId: 'user_task',
    userName: 'Task Tester',
    conversationId: 'conv_task',
    content: '自动化处理这些文件',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function createMockClaudeBridge(response = 'Claude says hi'): ClaudeAgentBridge {
  return {
    execute: mock(async (params: { onStream?: (e: StreamEvent) => void }) => {
      if (params.onStream) {
        params.onStream({ type: 'text_delta', text: response });
        params.onStream({ type: 'done' });
      }
      return {
        content: response,
        toolsUsed: [],
        turns: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      } satisfies AgentBridgeResult;
    }),
    estimateCost: () => 0.001,
    getActiveSessions: () => 0,
  } as unknown as ClaudeAgentBridge;
}

function createMockLightLLM(response = 'Light says hi'): LightLLMClient {
  return {
    complete: mock(async () => ({
      content: response,
      model: 'deepseek-chat',
      usage: { promptTokens: 5, completionTokens: 3, totalCost: 0.0001 },
    })),
    stream: mock(async function* () {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
    getDefaultModel: () => 'deepseek-chat',
  } as unknown as LightLLMClient;
}

// ── Tests ─────────────────────────────────────────────────

describe('任务队列管道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    CentralController.resetInstance();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── 消息分类 → TaskQueue 入队 ──────────────────────────

  describe('消息分类 → TaskQueue 入队', () => {
    test('包含 "自动化" 的消息应该路由到 TaskQueue 并返回结果', async () => {
      const taskQueue = new TaskQueue({
        concurrency: { globalSlots: 5, perUserSlots: 2 },
      });
      taskQueue.setHandler(
        mock(async (task: Task) => ({
          success: true,
          taskId: task.id,
          completedAt: Date.now(),
        })),
      );

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        taskQueue,
      });

      const msg = createMessage({ content: '自动化处理这些文件' });
      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
    });

    test('TaskQueue handler 应该接收到正确的 Task 对象', async () => {
      let capturedTask: Task | null = null;

      const taskQueue = new TaskQueue({
        concurrency: { globalSlots: 5, perUserSlots: 2 },
      });
      taskQueue.setHandler(async (task: Task) => {
        capturedTask = task;
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        taskQueue,
      });

      const msg = createMessage({
        content: '批量处理数据',
        userId: 'user_capture',
      });
      await controller.handleIncomingMessage(msg);

      expect(capturedTask).not.toBeNull();
      expect(capturedTask!.type).toBe('automation');
      expect(capturedTask!.message.content).toBe('批量处理数据');
      expect(capturedTask!.message.userId).toBe('user_capture');
    });
  });

  // ── TaskQueue + ConcurrencyController 并发控制 ─────────

  describe('TaskQueue + ConcurrencyController 并发控制', () => {
    test('并发任务应该受 globalSlots 限制', async () => {
      let peakActive = 0;
      let currentActive = 0;

      const taskQueue = new TaskQueue({
        concurrency: { globalSlots: 2, perUserSlots: 3 },
      });
      taskQueue.setHandler(async (task: Task) => {
        currentActive++;
        peakActive = Math.max(peakActive, currentActive);
        await new Promise((r) => setTimeout(r, 50));
        currentActive--;
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        taskQueue,
      });

      // 同时发 3 个自动化任务（不同 userId 避免 perUserSlots 限制）
      const results = await Promise.all([
        controller.handleIncomingMessage(
          createMessage({ content: '自动化任务1', userId: 'u1', conversationId: 'c1' }),
        ),
        controller.handleIncomingMessage(
          createMessage({ content: '自动化任务2', userId: 'u2', conversationId: 'c2' }),
        ),
        controller.handleIncomingMessage(
          createMessage({ content: '自动化任务3', userId: 'u3', conversationId: 'c3' }),
        ),
      ]);

      // 所有任务应最终成功
      for (const r of results) {
        expect(r.success).toBe(true);
      }
      // 峰值并发应受 globalSlots=2 限制
      expect(peakActive).toBeLessThanOrEqual(2);
    });

    test('同一用户的任务应该受 perUserSlots 限制', async () => {
      let peakActive = 0;
      let currentActive = 0;

      const taskQueue = new TaskQueue({
        concurrency: { globalSlots: 5, perUserSlots: 1 },
      });
      taskQueue.setHandler(async (task: Task) => {
        currentActive++;
        peakActive = Math.max(peakActive, currentActive);
        await new Promise((r) => setTimeout(r, 30));
        currentActive--;
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        taskQueue,
      });

      // 同一用户发 2 个并发任务
      const results = await Promise.all([
        controller.handleIncomingMessage(
          createMessage({ content: '自动化任务A', userId: 'same_user', conversationId: 'ca' }),
        ),
        controller.handleIncomingMessage(
          createMessage({ content: '自动化任务B', userId: 'same_user', conversationId: 'cb' }),
        ),
      ]);

      for (const r of results) {
        expect(r.success).toBe(true);
      }
      // perUserSlots=1，同一用户最多同时 1 个
      expect(peakActive).toBeLessThanOrEqual(1);
    });
  });

  // ── 重试机制集成 ──────────────────────────────────────────

  describe('重试机制集成', () => {
    test('handler 临时失败应该重试并最终成功', async () => {
      let callCount = 0;

      const taskQueue = new TaskQueue({
        concurrency: { globalSlots: 5, perUserSlots: 2 },
        maxRetries: 2,
        retryBaseDelayMs: 10,
      });
      taskQueue.setHandler(async (task: Task) => {
        callCount++;
        if (callCount < 3) {
          throw new Error('临时故障');
        }
        return { success: true, taskId: task.id, completedAt: Date.now() };
      });

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        taskQueue,
      });

      const result = await controller.handleIncomingMessage(
        createMessage({ content: '自动化需要重试的任务' }),
      );

      expect(result.success).toBe(true);
      expect(callCount).toBe(3);
    });

    test('handler 永久失败应该在重试耗尽后返回失败', async () => {
      let callCount = 0;

      const taskQueue = new TaskQueue({
        concurrency: { globalSlots: 5, perUserSlots: 2 },
        maxRetries: 1,
        retryBaseDelayMs: 10,
      });
      taskQueue.setHandler(async () => {
        callCount++;
        throw new Error('永久故障');
      });

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        taskQueue,
      });

      const result = await controller.handleIncomingMessage(
        createMessage({ content: '自动化会一直失败的任务' }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('永久故障');
      // 初始 1 次 + 重试 1 次 = 2 次
      expect(callCount).toBe(2);
    });
  });
});
