/**
 * 集成测试: 定时调度管道
 *
 * 测试完整的定时任务流程:
 *   BotMessage → classifyIntent('scheduled') → handleScheduledTask → nlToCron → Scheduler.register
 *   Scheduler.start → executeJob → executor 回调
 *
 * 所有 LLM 后端均使用 mock，不产生真实 API 调用。
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { AgentBridge, AgentResult } from '../kernel/agents/agent-bridge';
import type { LightLLMClient } from '../kernel/agents/light-llm-client';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { Scheduler } from '../kernel/scheduling/scheduler';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';

// ── Test helpers ──────────────────────────────────────────

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}`,
    channel: 'web',
    userId: 'user_sched',
    userName: 'Schedule Tester',
    conversationId: 'conv_sched',
    content: '请帮我设置每天早上9点提醒我开会',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

/** Mock LightLLM that classifies schedule-like messages as 'scheduled' */
function createScheduleClassifierLLM(): LightLLMClient {
  return {
    complete: async () => ({
      content:
        '{"taskType":"scheduled","complexity":"complex","subIntent":"create","reason":"定时任务"}',
      usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
    }),
    stream: async function* () {
      yield { content: 'test' };
    },
    getDefaultModel: () => 'gpt-4o-mini',
  } as unknown as LightLLMClient;
}

function createMockAgentBridge(response = 'Claude says hi'): AgentBridge {
  return {
    execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
      if (params.streamCallback) {
        await params.streamCallback({ type: 'text_delta', text: response });
        await params.streamCallback({ type: 'done' });
      }
      return {
        content: response,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        toolsUsed: [],
        finishedNaturally: true,
        handledBy: 'claude' as const,
      } satisfies AgentResult;
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('定时调度管道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    CentralController.resetInstance();
    scheduler = new Scheduler();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    scheduler.stop();
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── 消息分类 → 定时任务注册 ──────────────────────────────

  describe('消息分类 → 定时任务注册', () => {
    test('包含 "每天" 的消息应该被分类为 scheduled 并注册 Scheduler Job', async () => {
      const agentBridge = createMockAgentBridge();
      const controller = CentralController.getInstance({
        agentBridge,
        classifier: new TaskClassifier(createScheduleClassifierLLM()),
        scheduler,
      });

      const msg = createMessage({ content: '请帮我设置每天早上9点提醒我开会' });
      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).type).toBe('scheduled_registered');
      expect((result.data as Record<string, unknown>).cronExpression).toBeDefined();
      expect(scheduler.getJobCount()).toBe(1);

      const jobs = scheduler.listJobs('user_sched');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].userId).toBe('user_sched');
      expect(jobs[0].description).toBe('请帮我设置每天早上9点提醒我开会');
    });

    test('"提醒我" 的消息应该正确分类为 scheduled 并注册', async () => {
      const agentBridge = createMockAgentBridge();
      const controller = CentralController.getInstance({
        agentBridge,
        classifier: new TaskClassifier(createScheduleClassifierLLM()),
        scheduler,
      });

      const msg = createMessage({
        content: '请帮我设置每天下午3点提醒我开会',
        userId: 'user_remind',
      });
      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).type).toBe('scheduled_registered');

      const job = scheduler.listJobs('user_remind');
      expect(job).toHaveLength(1);
      expect(job[0].status).toBe('active');
    });
  });

  // ── Scheduler Executor 完整链路 ──────────────────────────

  describe('Scheduler Executor 完整链路', () => {
    test('注册的 Job 触发时应该调用 executor 回调', async () => {
      const executorFn = mock(async () => ({
        success: true,
        taskId: 'exec_1',
        completedAt: Date.now(),
      }));

      scheduler.setExecutor(executorFn);

      // 注册 job，用 '* * * * *' 使 nextRunAt 为最近的整分钟
      const jobId = await scheduler.register({
        cronExpression: '* * * * *',
        taskTemplate: { action: 'remind' },
        userId: 'user_exec',
        description: '每分钟执行',
      });

      // 手动将 nextRunAt 设为过去时间以立即触发
      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();
      if (job) job.nextRunAt = Date.now() - 1000;

      // start 会调用 scheduleNextRun，发现 delay <= 0 立即执行
      scheduler.start();

      // 等待异步执行完成
      await new Promise((r) => setTimeout(r, 100));

      expect(executorFn).toHaveBeenCalledTimes(1);
      expect(job?.executionCount).toBe(1);
      expect(job?.lastResult?.success).toBe(true);
    });

    test('executor 失败时 Job 应该记录错误结果但保持 active', async () => {
      const failingExecutor = mock(async () => {
        throw new Error('executor 执行出错');
      });

      scheduler.setExecutor(failingExecutor);

      const jobId = await scheduler.register({
        cronExpression: '* * * * *',
        taskTemplate: { action: 'fail_test' },
        userId: 'user_fail',
        description: '会失败的任务',
      });

      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();
      if (job) job.nextRunAt = Date.now() - 1000;

      scheduler.start();
      await new Promise((r) => setTimeout(r, 100));

      expect(failingExecutor).toHaveBeenCalledTimes(1);
      expect(job.lastResult?.success).toBe(false);
      expect(job.lastResult?.error).toContain('executor 执行出错');
      // Job 应该保持 active，不因为单次失败而被取消
      expect(job.status).toBe('active');
    });
  });

  // ── Job 生命周期管理 ──────────────────────────────────────

  describe('Job 生命周期管理', () => {
    test('注册的 Job 应该支持 pause / resume / cancel', async () => {
      const controller = CentralController.getInstance({
        agentBridge: createMockAgentBridge(),
        classifier: new TaskClassifier(createScheduleClassifierLLM()),
        scheduler,
      });

      const msg = createMessage({ content: '请帮我设置每天上午9点提醒我写周报' });
      const result = await controller.handleIncomingMessage(msg);
      const jobId = (result.data as Record<string, unknown>).jobId as string;

      // Pause
      const paused = scheduler.pause(jobId);
      expect(paused).toBe(true);
      expect(scheduler.getJob(jobId)?.status).toBe('paused');

      // Resume
      const resumed = scheduler.resume(jobId);
      expect(resumed).toBe(true);
      expect(scheduler.getJob(jobId)?.status).toBe('active');

      // Cancel
      const cancelled = scheduler.cancel(jobId);
      expect(cancelled).toBe(true);
      expect(scheduler.getJob(jobId)?.status).toBe('cancelled');
    });

    test('多个用户的定时任务应该隔离', async () => {
      const controller = CentralController.getInstance({
        agentBridge: createMockAgentBridge(),
        classifier: new TaskClassifier(createScheduleClassifierLLM()),
        scheduler,
      });

      await controller.handleIncomingMessage(
        createMessage({
          content: '请帮我设置每天上午8点提醒我锻炼',
          userId: 'user_A',
          conversationId: 'conv_A',
        }),
      );
      await controller.handleIncomingMessage(
        createMessage({
          content: '请帮我设置每周一上午10点提醒我整理',
          userId: 'user_B',
          conversationId: 'conv_B',
        }),
      );

      expect(scheduler.getJobCount()).toBe(2);
      expect(scheduler.listJobs('user_A')).toHaveLength(1);
      expect(scheduler.listJobs('user_B')).toHaveLength(1);
      expect(scheduler.listJobs('user_A')[0].userId).toBe('user_A');
      expect(scheduler.listJobs('user_B')[0].userId).toBe('user_B');
    });
  });
});
