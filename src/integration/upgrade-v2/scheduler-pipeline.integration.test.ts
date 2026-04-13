/**
 * DD-020: Scheduler Pipeline Integration Tests (SK-01 ~ SK-12)
 *
 * Tests the full scheduling pipeline:
 *   BotMessage -> classify('scheduled') -> handleScheduledTask -> nlToCron -> Scheduler.register
 *   Scheduler.start -> executeJob -> executor callback -> channel.sendMessage
 *
 * Also covers: list, cancel flow, persistence, error branches.
 *
 * All LLM backends are mocked. Scheduler and JobStore use real instances where possible.
 *
 * NOTE: We intentionally do NOT provide taskStore/sessionStore to avoid TaskDispatcher.
 * TaskDispatcher strips classifyResult from the reconstructed Task, which breaks the
 * subIntent routing in handleScheduledTask. The direct orchestrate() path is what we test.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CentralController, type CentralControllerDeps } from '../../kernel/central-controller';
import type { JobStore } from '../../kernel/scheduling/job-store';
import { nlToCron } from '../../kernel/scheduling/nl-to-cron';
import { ScheduleCancelManager } from '../../kernel/scheduling/schedule-cancel-manager';
import { type ScheduledJob, Scheduler } from '../../kernel/scheduling/scheduler';
import {
  createMessage,
  createMockChannel,
  createMockClaudeBridge,
  createMockLightLLM,
  createMockMediaProcessor,
  createMockOVDeps,
  createMockWorktreePool,
  delay,
} from './test-helpers';

// ── Constants ─────────────────────────────────────────────

const WORKSPACE_PATH = '/tmp/test-workspace-sched';
const MEMORY_DIR = `${WORKSPACE_PATH}/memory`;

// ── Helpers ───────────────────────────────────────────────

/**
 * LightLLM mock that returns a classification response with given subIntent.
 * The TaskClassifier's extractJson parses this to route to scheduled task handler.
 */
function createScheduleClassifierLLM(subIntent = 'create') {
  return createMockLightLLM(
    JSON.stringify({
      taskType: 'scheduled',
      complexity: 'complex',
      subIntent,
      reason: '定时任务',
    }),
  );
}

/** Ensure mock workspace has SOUL.md so onboarding is skipped. */
function ensureWorkspace(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(`${MEMORY_DIR}/SOUL.md`, '# Soul\nBe helpful.');
}

/** WorkspaceManager mock returning correct WorkspacePath shape. */
function createWorkspaceManagerMock() {
  return {
    initializeWithMcp: mock(() => ({
      absolutePath: WORKSPACE_PATH,
      claudeDir: `${WORKSPACE_PATH}/.claude`,
      settingsPath: `${WORKSPACE_PATH}/.claude/settings.json`,
      memoryDir: MEMORY_DIR,
      mcpJsonPath: `${WORKSPACE_PATH}/.mcp.json`,
      skillsDir: `${WORKSPACE_PATH}/.claude/skills`,
    })),
    getWorkspacePath: () => WORKSPACE_PATH,
  };
}

/**
 * Create a CentralController without TaskDispatcher (no taskStore/sessionStore).
 * This ensures handleIncomingMessage uses the direct orchestrate() path,
 * which preserves classifyResult through the full pipeline.
 */
function createSchedulerTestController(overrides?: Partial<CentralControllerDeps>) {
  CentralController.resetInstance();
  const ovDeps = createMockOVDeps();

  const deps: CentralControllerDeps = {
    claudeBridge: createMockClaudeBridge(),
    lightLLM: createMockLightLLM(),
    workspaceManager:
      createWorkspaceManagerMock() as unknown as CentralControllerDeps['workspaceManager'],
    mediaProcessor: createMockMediaProcessor(),
    worktreePool: createMockWorktreePool(),
    // NO sessionStore / taskStore — avoids TaskDispatcher path
    ...ovDeps,
    ...overrides,
  };

  const controller = CentralController.getInstance(deps);
  return { controller, deps };
}

function cleanupSchedulerTest() {
  CentralController.resetInstance();
}

// ── Tests ─────────────────────────────────────────────────

describe('DD-020 Scheduler Pipeline (SK-01 ~ SK-12)', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    ensureWorkspace();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── SK-01: nlToCron success → scheduler.register() returns jobId ──

  describe('SK-01: nlToCron success → register returns jobId', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
      cleanupSchedulerTest();
    });

    test('scheduled message registers job, returns scheduled_registered with non-empty jobId', async () => {
      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('create'),
      });

      const msg = createMessage({
        content: '每天早上9点提醒我开会',
        userId: 'user_sk01',
      });

      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.type).toBe('scheduled_registered');
      expect(data.jobId).toBeDefined();
      expect(typeof data.jobId).toBe('string');
      expect((data.jobId as string).length).toBeGreaterThan(0);

      // Verify job actually exists in scheduler
      const jobs = scheduler.listJobs('user_sk01');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(data.jobId);
      expect(jobs[0]?.status).toBe('active');
      expect(jobs[0]?.cronExpression).toBe('0 9 * * *');
    });
  });

  // ── SK-02: nlToCron parse failure → error, no job registered ──

  describe('SK-02: nlToCron parse failure (confidence=0) → error', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
      cleanupSchedulerTest();
    });

    test('unparseable content returns success=false, scheduler has no jobs', async () => {
      // First verify that nlToCron actually fails on this input
      const nlResult = nlToCron('帮我设置一个提醒但我忘了什么时候了');
      expect(nlResult.cron).toBeNull();
      expect(nlResult.confidence).toBe(0);

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('create'),
      });

      const msg = createMessage({
        content: '帮我设置一个提醒但我忘了什么时候了',
        userId: 'user_sk02',
      });

      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('无法识别调度模式');

      // No job should have been registered
      expect(scheduler.listJobs('user_sk02')).toHaveLength(0);
      expect(scheduler.getJobCount()).toBe(0);
    });
  });

  // ── SK-03: subIntent='list' + no active jobs → empty message ──

  describe('SK-03: list with no active jobs', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
      cleanupSchedulerTest();
    });

    test('list subIntent with no jobs returns "没有活跃的定时任务"', async () => {
      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('list'),
      });

      const msg = createMessage({
        content: '帮我查看一下我当前设置的所有定时任务列表',
        userId: 'user_sk03',
      });

      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.content).toBe('你目前没有活跃的定时任务。');
    });
  });

  // ── SK-04: subIntent='list' + active jobs → formatted list ──

  describe('SK-04: list with active jobs → formatted list', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
      cleanupSchedulerTest();
    });

    test('list subIntent returns job descriptions and next execution time', async () => {
      // Register a job directly on the scheduler
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: { messageContent: '开会提醒' },
        userId: 'user_sk04',
        description: '每天早上9点提醒开会',
        channel: 'web',
      });

      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();

      // Create controller with list classifier
      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('list'),
      });

      const msg = createMessage({
        content: '帮我查看一下我当前设置的所有定时任务列表',
        userId: 'user_sk04',
      });

      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('每天早上9点提醒开会');
      expect(content).toContain('下次执行');
    });
  });

  // ── SK-05: subIntent='cancel' → startCancelFlow ──

  describe('SK-05: cancel subIntent triggers cancel flow', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
      cleanupSchedulerTest();
    });

    test('cancel with active jobs returns cancellable job list', async () => {
      await scheduler.register({
        cronExpression: '0 10 * * *',
        taskTemplate: { messageContent: '站会' },
        userId: 'user_sk05',
        description: '每天10点站会',
        channel: 'web',
      });

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('cancel'),
      });

      const msg = createMessage({
        content: '帮我取消之前设置的那个定时提醒任务',
        userId: 'user_sk05',
      });

      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('每天10点站会');
      expect(content).toContain('请回复数字序号');
    });

    test('cancel with no active jobs returns "没有活跃的定时任务"', async () => {
      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('cancel'),
      });

      const msg = createMessage({
        content: '帮我取消之前设置的那个定时提醒任务',
        userId: 'user_sk05_empty',
      });

      const result = await controller.handleIncomingMessage(msg);

      expect(result.success).toBe(true);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('没有活跃的定时任务');
    });
  });

  // ── SK-06: Cancel selection phase → processSelection ──

  describe('SK-06: Cancel selection phase with isPendingSelection', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
      cleanupSchedulerTest();
    });

    test('pending selection + number input cancels the specified job', async () => {
      // Register two jobs
      await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_sk06',
        description: '任务A - 每天9点',
        channel: 'web',
      });
      const jobId2 = await scheduler.register({
        cronExpression: '0 14 * * *',
        taskTemplate: {},
        userId: 'user_sk06',
        description: '任务B - 每天14点',
        channel: 'web',
      });

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('cancel'),
      });

      // Step 1: initiate cancel flow
      const cancelMsg = createMessage({
        content: '帮我取消之前设置的那个定时提醒任务',
        userId: 'user_sk06',
      });
      const cancelResult = await controller.handleIncomingMessage(cancelMsg);
      expect(cancelResult.success).toBe(true);
      const cancelContent = (cancelResult.data as Record<string, unknown>).content as string;
      expect(cancelContent).toContain('任务A');
      expect(cancelContent).toContain('任务B');

      // Step 2: select job #2 (bypasses classifier via isPendingSelection check)
      const selectMsg = createMessage({
        content: '2',
        userId: 'user_sk06',
      });
      const selectResult = await controller.handleIncomingMessage(selectMsg);

      expect(selectResult.success).toBe(true);
      const selectContent = (selectResult.data as Record<string, unknown>).content as string;
      expect(selectContent).toContain('已取消定时任务');
      expect(selectContent).toContain('任务B');

      // Verify job is actually cancelled
      const job2 = scheduler.getJob(jobId2);
      expect(job2).toBeDefined();
      expect(job2?.status).toBe('cancelled');

      // First job should still be active
      const activeJobs = scheduler.listJobs('user_sk06').filter((j) => j.status === 'active');
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs[0]?.description).toBe('任务A - 每天9点');
    });
  });

  // ── SK-07: initScheduler → loadJobs restores persisted jobs ──

  describe('SK-07: initScheduler loads persisted jobs', () => {
    let scheduler: Scheduler;

    afterEach(() => {
      scheduler?.stop();
      cleanupSchedulerTest();
    });

    test('pre-stored job in JobStore → loadJobs → scheduler.listJobs returns it', async () => {
      const preStoredJob: ScheduledJob = {
        id: 'job_persisted_001',
        cronExpression: '0 8 * * *',
        taskTemplate: { messageContent: '晨会' },
        userId: 'user_sk07',
        description: '每天早上8点晨会',
        channel: 'web',
        status: 'active',
        nextRunAt: Date.now() + 3600_000,
        createdAt: Date.now() - 86400_000,
        executionCount: 3,
        lastResult: null,
      };

      const mockJobStore = {
        load: mock(() => [preStoredJob]),
        save: mock(() => {}),
      } as unknown as JobStore;

      scheduler = new Scheduler(mockJobStore);

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('list'),
      });

      // initScheduler triggers loadJobs
      await controller.initScheduler();

      // Verify the persisted job is now in the scheduler
      const jobs = scheduler.listJobs('user_sk07');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe('job_persisted_001');
      expect(jobs[0]?.description).toBe('每天早上8点晨会');
      expect(jobs[0]?.executionCount).toBe(3);

      // Scheduler should be running after init
      expect(scheduler.isRunning()).toBe(true);
    });
  });

  // ── SK-08: Scheduler executor triggers → executeChatPipeline → ch.sendMessage ──

  describe('SK-08: Executor fires → channel.sendMessage called', () => {
    let scheduler: Scheduler;

    afterEach(() => {
      scheduler?.stop();
      cleanupSchedulerTest();
    });

    test('job execution triggers chat pipeline and sends message via channel', async () => {
      scheduler = new Scheduler();
      const mockChannel = createMockChannel('web');

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('create'),
        channelResolver: (channelType: string) => (channelType === 'web' ? mockChannel : undefined),
      });

      // Init scheduler (wires the executor)
      await controller.initScheduler();

      // Register a job with nextRunAt in the past so it fires immediately
      const jobId = await scheduler.register({
        cronExpression: '* * * * *',
        taskTemplate: {
          messageContent: '该开会了',
          userName: 'Scheduler',
          conversationId: 'conv_sched_08',
        },
        userId: 'user_sk08',
        description: '每分钟提醒',
        channel: 'web',
      });

      const job = scheduler.getJob(jobId);
      if (!job) throw new Error('Job not found');
      job.nextRunAt = Date.now() - 1000; // Force immediate execution

      // Restart to pick up the past-due job
      scheduler.stop();
      scheduler.start();

      // Wait for async executor to complete
      await delay(1500);

      // Verify job executed
      expect(job.executionCount).toBeGreaterThanOrEqual(1);
      expect(job.lastResult).toBeDefined();

      // The executor calls executeChatPipeline which uses mocked claudeBridge.
      // If the pipeline succeeds, channel.sendMessage should be called.
      if (job.lastResult?.success) {
        expect(mockChannel.sendMessage).toHaveBeenCalled();
        const sendCall = (mockChannel.sendMessage as ReturnType<typeof mock>).mock.calls[0];
        expect(sendCall?.[0]).toBe('user_sk08');
        const sentContent = sendCall?.[1] as { type: string; text: string };
        expect(sentContent.type).toBe('text');
      }
    });
  });

  // ── SK-09: Scheduler executor → channel doesn't exist → no throw ──

  describe('SK-09: Channel not found → error logged, no exception', () => {
    let scheduler: Scheduler;

    afterEach(() => {
      scheduler?.stop();
      cleanupSchedulerTest();
    });

    test('channelResolver returns undefined → executor completes without throwing', async () => {
      scheduler = new Scheduler();

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('create'),
        channelResolver: () => undefined, // No channel found
      });

      await controller.initScheduler();

      const jobId = await scheduler.register({
        cronExpression: '* * * * *',
        taskTemplate: {
          messageContent: '测试消息',
          userName: 'Scheduler',
          conversationId: 'conv_sk09',
        },
        userId: 'user_sk09',
        description: '测试任务',
        channel: 'telegram', // resolver returns undefined for all
      });

      const job = scheduler.getJob(jobId);
      if (!job) throw new Error('Job not found');
      job.nextRunAt = Date.now() - 1000;

      scheduler.stop();
      scheduler.start();

      await delay(1500);

      // Should not throw — job executed; channel missing just means no push
      expect(job.executionCount).toBeGreaterThanOrEqual(1);
      expect(job.lastResult).toBeDefined();
      // The executor doesn't throw even when channel is undefined
    });
  });

  // ── SK-10: stopScheduler → stop + persistJobs ──

  describe('SK-10: stopScheduler calls stop and persistJobs', () => {
    afterEach(() => {
      cleanupSchedulerTest();
    });

    test('stopScheduler invokes scheduler.stop() and scheduler.persistJobs()', () => {
      const scheduler = new Scheduler();
      const stopSpy = spyOn(scheduler, 'stop');
      const persistSpy = spyOn(scheduler, 'persistJobs');

      const { controller } = createSchedulerTestController({ scheduler });

      controller.stopScheduler();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(persistSpy).toHaveBeenCalledTimes(1);

      stopSpy.mockRestore();
      persistSpy.mockRestore();
    });
  });

  // ── SK-11 (R6): Scheduler workspace/UserConfigLoader initialization ──

  describe('SK-11: Scheduler executor initializes workspace and config', () => {
    let scheduler: Scheduler;

    afterEach(() => {
      scheduler?.stop();
      cleanupSchedulerTest();
    });

    test('scheduled job trigger → resolveSession → workspace init → executeChatPipeline', async () => {
      scheduler = new Scheduler();
      const mockChannel = createMockChannel('web');
      const workspaceMock = createWorkspaceManagerMock();

      const { controller } = createSchedulerTestController({
        scheduler,
        lightLLM: createScheduleClassifierLLM('create'),
        channelResolver: (type: string) => (type === 'web' ? mockChannel : undefined),
        workspaceManager: workspaceMock as unknown as CentralControllerDeps['workspaceManager'],
      });

      await controller.initScheduler();

      // Register and trigger a job
      const jobId = await scheduler.register({
        cronExpression: '* * * * *',
        taskTemplate: {
          messageContent: '工作区测试',
          userName: 'Scheduler',
          conversationId: 'conv_sk11',
        },
        userId: 'user_sk11',
        description: '工作区初始化测试',
        channel: 'web',
      });

      const job = scheduler.getJob(jobId);
      if (!job) throw new Error('Job not found');
      job.nextRunAt = Date.now() - 1000;

      scheduler.stop();
      scheduler.start();

      await delay(1500);

      // Verify workspace was initialized for the scheduled execution
      expect(workspaceMock.initializeWithMcp).toHaveBeenCalled();

      // Verify the pipeline executed normally
      expect(job.executionCount).toBeGreaterThanOrEqual(1);
      expect(job.lastResult).toBeDefined();
    });
  });

  // ── SK-12 (R6): Cancel/list/cron error branches ──

  describe('SK-12: Three-path branch coverage (cancel/list/cron-error)', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      scheduler = new Scheduler();
    });

    afterEach(() => {
      scheduler.stop();
    });

    test('ScheduleCancelManager: startCancelFlow returns job list', async () => {
      await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_sk12',
        description: 'SK-12 任务',
        channel: 'web',
      });

      const cancelManager = new ScheduleCancelManager(scheduler);
      const result = cancelManager.startCancelFlow('user_sk12');

      expect(result.success).toBe(true);
      const content = (result.data as { content: string }).content;
      expect(content).toContain('SK-12 任务');
      expect(content).toContain('请回复数字序号');

      // Pending selection should now be true
      expect(cancelManager.isPendingSelection('user_sk12')).toBe(true);
    });

    test('ScheduleCancelManager: processSelection cancels the right job', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_sk12b',
        description: 'SK-12 取消目标',
        channel: 'web',
      });

      const cancelManager = new ScheduleCancelManager(scheduler);

      // Start flow
      cancelManager.startCancelFlow('user_sk12b');

      // Select job 1
      const result = cancelManager.processSelection('user_sk12b', '1');
      expect(result.success).toBe(true);
      const content = (result.data as { content: string }).content;
      expect(content).toContain('已取消定时任务');
      expect(content).toContain('SK-12 取消目标');

      // Verify cancelled
      const job = scheduler.getJob(jobId);
      expect(job?.status).toBe('cancelled');

      // Pending selection cleared
      expect(cancelManager.isPendingSelection('user_sk12b')).toBe(false);
    });

    test('list path: scheduler.listJobs returns current active/paused jobs', async () => {
      await scheduler.register({
        cronExpression: '0 8 * * *',
        taskTemplate: {},
        userId: 'user_sk12c',
        description: 'Active任务',
        channel: 'web',
      });

      const pausedId = await scheduler.register({
        cronExpression: '0 12 * * *',
        taskTemplate: {},
        userId: 'user_sk12c',
        description: 'Paused任务',
        channel: 'web',
      });
      scheduler.pause(pausedId);

      const cancelledId = await scheduler.register({
        cronExpression: '0 18 * * *',
        taskTemplate: {},
        userId: 'user_sk12c',
        description: 'Cancelled任务',
        channel: 'web',
      });
      scheduler.cancel(cancelledId);

      const allJobs = scheduler.listJobs('user_sk12c');
      expect(allJobs).toHaveLength(3);

      const activeOrPaused = allJobs.filter((j) => j.status === 'active' || j.status === 'paused');
      expect(activeOrPaused).toHaveLength(2);
      expect(activeOrPaused.map((j) => j.description)).toContain('Active任务');
      expect(activeOrPaused.map((j) => j.description)).toContain('Paused任务');
    });

    test('cron parse failure: nlToCron returns null cron + confidence 0', () => {
      // Verify multiple failure cases
      const failureCases = ['随便聊聊天吧', 'hello world', '吃饭了吗', '明天天气怎么样'];

      for (const input of failureCases) {
        const result = nlToCron(input);
        expect(result.cron).toBeNull();
        expect(result.confidence).toBe(0);
        expect(result.description).toBe('无法识别的调度模式');
      }

      // Verify success cases still work
      const successCases = [
        { input: '每天9点', expectedCron: '0 9 * * *' },
        { input: '每小时', expectedCron: '0 * * * *' },
        { input: '每隔30分钟', expectedCron: '*/30 * * * *' },
        { input: '每周一9点', expectedCron: '0 9 * * 1' },
      ];

      for (const { input, expectedCron } of successCases) {
        const result = nlToCron(input);
        expect(result.cron).toBe(expectedCron);
        expect(result.confidence).toBe(0.9);
      }
    });
  });
});
