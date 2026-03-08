import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { TaskResult } from '../../shared/tasking/task-result.types';
import type { JobStore } from './job-store';
import { type ScheduledJob, Scheduler } from './scheduler';

describe('Scheduler', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.stop();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('register', () => {
    test('应该注册 job 并返回 job ID', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: { action: 'remind' },
        userId: 'user_001',
      });

      expect(jobId).toMatch(/^job_/);
    });

    test('应该正确追踪 job 计数', async () => {
      expect(scheduler.getJobCount()).toBe(0);

      await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });
      expect(scheduler.getJobCount()).toBe(1);

      await scheduler.register({
        cronExpression: '0 18 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });
      expect(scheduler.getJobCount()).toBe(2);
    });

    test('应该生成唯一的 job ID', async () => {
      const id1 = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });
      const id2 = await scheduler.register({
        cronExpression: '0 18 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      expect(id1).not.toBe(id2);
    });

    test('应该正确初始化 job 字段', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: { key: 'value' },
        userId: 'user_001',
        description: 'Morning reminder',
      });

      const job = scheduler.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.status).toBe('active');
      expect(job?.executionCount).toBe(0);
      expect(job?.description).toBe('Morning reminder');
      expect(job?.channel).toBe('api');
      expect(job?.nextRunAt).toBeGreaterThan(Date.now());
      expect(job?.lastResult).toBeNull();
    });

    test('channel 应该默认为 api', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      expect(scheduler.getJob(jobId)?.channel).toBe('api');
    });

    test('应该接受显式传入的 channel', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
        channel: 'feishu',
      });

      expect(scheduler.getJob(jobId)?.channel).toBe('feishu');
    });
  });

  describe('start/stop', () => {
    test('应该切换运行状态', () => {
      expect(scheduler.isRunning()).toBe(false);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    test('重复 start 应该是幂等的', () => {
      scheduler.start();
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
    });
  });

  describe('pause/resume', () => {
    test('应该暂停活跃的 job', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      expect(scheduler.pause(jobId)).toBe(true);
      expect(scheduler.getJob(jobId)?.status).toBe('paused');
    });

    test('应该恢复暂停的 job', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      scheduler.pause(jobId);
      expect(scheduler.resume(jobId)).toBe(true);
      expect(scheduler.getJob(jobId)?.status).toBe('active');
    });

    test('暂停非活跃 job 应该返回 false', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      scheduler.cancel(jobId);
      expect(scheduler.pause(jobId)).toBe(false);
    });

    test('恢复非暂停 job 应该返回 false', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      expect(scheduler.resume(jobId)).toBe(false); // Not paused
    });
  });

  describe('cancel', () => {
    test('应该取消 job', async () => {
      const jobId = await scheduler.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      expect(scheduler.cancel(jobId)).toBe(true);
      expect(scheduler.getJob(jobId)?.status).toBe('cancelled');
    });

    test('取消不存在的 job 应该返回 false', () => {
      expect(scheduler.cancel('nonexistent')).toBe(false);
    });
  });

  describe('listJobs', () => {
    test('应该列出所有 job', async () => {
      await scheduler.register({ cronExpression: '0 9 * * *', taskTemplate: {}, userId: 'user_A' });
      await scheduler.register({
        cronExpression: '0 18 * * *',
        taskTemplate: {},
        userId: 'user_B',
      });

      expect(scheduler.listJobs().length).toBe(2);
    });

    test('应该按 userId 过滤', async () => {
      await scheduler.register({ cronExpression: '0 9 * * *', taskTemplate: {}, userId: 'user_A' });
      await scheduler.register({
        cronExpression: '0 18 * * *',
        taskTemplate: {},
        userId: 'user_B',
      });
      await scheduler.register({
        cronExpression: '0 12 * * *',
        taskTemplate: {},
        userId: 'user_A',
      });

      expect(scheduler.listJobs('user_A').length).toBe(2);
      expect(scheduler.listJobs('user_B').length).toBe(1);
    });
  });

  describe('loadJobs', () => {
    test('应该从 store 加载 jobs', async () => {
      const mockStore = {
        load: () => [
          {
            id: 'job_stored_1',
            cronExpression: '0 9 * * *',
            taskTemplate: {},
            userId: 'user_001',
            description: 'Stored job',
            channel: 'api' as const,
            status: 'active' as const,
            nextRunAt: Date.now() + 60000,
            createdAt: Date.now(),
            executionCount: 0,
            lastResult: null,
          },
        ],
        save: () => {},
      } as unknown as JobStore;

      const s = new Scheduler(mockStore);
      await s.loadJobs();

      expect(s.getJobCount()).toBe(1);
      expect(s.getJob('job_stored_1')).toBeDefined();
      s.stop();
    });

    test('无 store 时 loadJobs 应该直接返回', async () => {
      const s = new Scheduler();
      await s.loadJobs();
      expect(s.getJobCount()).toBe(0);
    });
  });

  describe('persistJobs', () => {
    test('应该持久化 jobs 到 store', async () => {
      let saveCount = 0;
      let lastSaved: ScheduledJob[] = [];
      const mockStore = {
        load: () => [],
        save: (jobs: ScheduledJob[]) => {
          saveCount++;
          lastSaved = jobs;
        },
      } as unknown as JobStore;

      const s = new Scheduler(mockStore);
      // register calls persistJobs internally
      await s.register({
        cronExpression: '0 9 * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      // save was called once by register
      expect(saveCount).toBe(1);
      expect(lastSaved.length).toBe(1);

      // explicit persistJobs call
      s.persistJobs();
      expect(saveCount).toBe(2);
      s.stop();
    });
  });

  describe('executor callback', () => {
    test('应该在 job 触发时调用 executor', async () => {
      const results: string[] = [];
      scheduler.setExecutor(async (job: ScheduledJob): Promise<TaskResult> => {
        results.push(job.id);
        return { success: true, taskId: job.id, completedAt: Date.now() };
      });

      // Register with a very short delay (past due = execute immediately)
      const jobId = await scheduler.register({
        cronExpression: '* * * * *', // Every minute
        taskTemplate: { action: 'test' },
        userId: 'user_001',
      });

      // Manually get the job and set nextRunAt to the past
      const job = scheduler.getJob(jobId);
      if (!job) throw new Error('Expected job to exist');
      job.nextRunAt = Date.now() - 1000;

      scheduler.start();
      // Wait for immediate execution
      await new Promise((r) => setTimeout(r, 50));

      expect(results.length).toBe(1);
      expect(results[0]).toBe(jobId);
      expect(job.executionCount).toBe(1);
      expect(job.lastResult?.success).toBe(true);
    });

    test('executor 失败应该记录错误但不崩溃', async () => {
      scheduler.setExecutor(async () => {
        throw new Error('Executor failed');
      });

      const jobId = await scheduler.register({
        cronExpression: '* * * * *',
        taskTemplate: {},
        userId: 'user_001',
      });

      const job = scheduler.getJob(jobId);
      if (!job) throw new Error('Expected job to exist');
      job.nextRunAt = Date.now() - 1000;

      scheduler.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(job.lastResult?.success).toBe(false);
      expect(job.lastResult?.error).toContain('Executor failed');
    });
  });
});
