import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ScheduleCancelManager } from './schedule-cancel-manager';
import { Scheduler } from './scheduler';
import type { ScheduledJob } from './scheduler';

function createMockJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job_001',
    cronExpression: '0 9 * * *',
    taskTemplate: { messageContent: '喝水' },
    userId: 'user_001',
    description: '每天上午9点提醒我喝水',
    channel: 'web',
    status: 'active',
    nextRunAt: Date.now() + 86400000,
    createdAt: Date.now(),
    executionCount: 0,
    lastResult: null,
    ...overrides,
  };
}

describe('ScheduleCancelManager', () => {
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

  describe('startCancelFlow', () => {
    test('无活跃任务时直接返回提示', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([]);
      const manager = new ScheduleCancelManager(scheduler);

      const result = manager.startCancelFlow('user_001');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('没有活跃的定时任务');
    });

    test('已取消的任务不应出现在列表中', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob({ status: 'cancelled' })]);
      const manager = new ScheduleCancelManager(scheduler);

      const result = manager.startCancelFlow('user_001');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('没有活跃的定时任务');
    });

    test('有活跃任务时返回编号列表并存储 pending 状态', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([
        createMockJob({ id: 'job_001', description: '每天上午9点提醒我喝水' }),
        createMockJob({ id: 'job_002', description: '每周一发送周报' }),
      ]);
      const manager = new ScheduleCancelManager(scheduler);

      const result = manager.startCancelFlow('user_001');
      expect(result.success).toBe(true);
      const content = (result.data as { content: string }).content;
      expect(content).toContain('1. 每天上午9点提醒我喝水');
      expect(content).toContain('2. 每周一发送周报');
      expect(content).toContain('请回复数字序号');
      expect(manager.isPendingSelection('user_001')).toBe(true);
    });
  });

  describe('isPendingSelection', () => {
    test('无 pending 状态时返回 false', () => {
      const scheduler = new Scheduler();
      const manager = new ScheduleCancelManager(scheduler);
      expect(manager.isPendingSelection('user_001')).toBe(false);
    });

    test('有 pending 状态时返回 true', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob()]);
      const manager = new ScheduleCancelManager(scheduler);
      manager.startCancelFlow('user_001');
      expect(manager.isPendingSelection('user_001')).toBe(true);
    });
  });

  describe('processSelection', () => {
    test('有效数字选择应取消对应任务', () => {
      const scheduler = new Scheduler();
      const job = createMockJob({ id: 'job_001' });
      spyOn(scheduler, 'listJobs').mockReturnValue([job]);
      spyOn(scheduler, 'getJob').mockReturnValue(job);
      spyOn(scheduler, 'cancel').mockReturnValue(true);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', '1');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('已取消定时任务');
      expect(scheduler.cancel).toHaveBeenCalledWith('job_001');
    });

    test('回复"算了"应取消操作', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob()]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', '算了');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toBe('已取消操作。');
      expect(manager.isPendingSelection('user_001')).toBe(false);
    });

    test('回复"取消"应取消操作', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob()]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', '取消');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toBe('已取消操作。');
    });

    test('回复"0"应取消操作', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob()]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', '0');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toBe('已取消操作。');
    });

    test('非数字输入应提示重新输入', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob()]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', 'abc');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('请回复数字序号');
      expect(manager.isPendingSelection('user_001')).toBe(true);
    });

    test('超范围数字应提示范围', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([
        createMockJob({ id: 'job_001' }),
        createMockJob({ id: 'job_002' }),
      ]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', '5');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('1-2');
      expect(manager.isPendingSelection('user_001')).toBe(true);
    });

    test('选择的 job 已被取消时应返回"已不存在"', () => {
      const scheduler = new Scheduler();
      const job = createMockJob({ id: 'job_001' });
      spyOn(scheduler, 'listJobs').mockReturnValue([job]);
      spyOn(scheduler, 'getJob').mockReturnValue({ ...job, status: 'cancelled' });
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');
      const result = manager.processSelection('user_001', '1');
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('已不存在或已结束');
    });

    test('无 pending 状态时返回错误', () => {
      const scheduler = new Scheduler();
      const manager = new ScheduleCancelManager(scheduler);

      const result = manager.processSelection('user_001', '1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('没有待处理的取消操作');
    });

    test('超时后应返回超时提示', () => {
      const scheduler = new Scheduler();
      const job = createMockJob();
      spyOn(scheduler, 'listJobs').mockReturnValue([job]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');

      // Manually expire the pending selection by manipulating internal state
      // We access the private map through a workaround
      const pendingMap = (
        manager as unknown as {
          pendingSelections: Map<string, { jobs: ScheduledJob[]; createdAt: number }>;
        }
      ).pendingSelections;
      const pending = pendingMap.get('user_001')!;
      pending.createdAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

      const result = manager.processSelection('user_001', '1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('超时');
    });

    test('超时后 isPendingSelection 返回 false', () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([createMockJob()]);
      const manager = new ScheduleCancelManager(scheduler);

      manager.startCancelFlow('user_001');

      const pendingMap = (
        manager as unknown as {
          pendingSelections: Map<string, { jobs: ScheduledJob[]; createdAt: number }>;
        }
      ).pendingSelections;
      const pending = pendingMap.get('user_001')!;
      pending.createdAt = Date.now() - 6 * 60 * 1000;

      expect(manager.isPendingSelection('user_001')).toBe(false);
    });
  });
});
