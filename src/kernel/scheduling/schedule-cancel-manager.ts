import { Logger } from '../../shared/logging/logger';
import type { TaskResult } from '../../shared/tasking/task-result.types';
import { generateTaskId } from '../../shared/utils/crypto';
import type { ScheduledJob, Scheduler } from './scheduler';

interface PendingCancelSelection {
  jobs: ScheduledJob[];
  createdAt: number;
}

const CANCEL_KEYWORDS = ['算了', '取消', '0'];
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ScheduleCancelManager {
  private pendingSelections = new Map<string, PendingCancelSelection>();
  private readonly logger = new Logger('ScheduleCancelManager');

  constructor(private readonly scheduler: Scheduler) {}

  isPendingSelection(userId: string): boolean {
    const pending = this.pendingSelections.get(userId);
    if (!pending) return false;

    // Auto-expire after TTL
    if (Date.now() - pending.createdAt > TTL_MS) {
      this.pendingSelections.delete(userId);
      return false;
    }
    return true;
  }

  startCancelFlow(userId: string): TaskResult {
    const activeJobs = this.scheduler
      .listJobs(userId)
      .filter((j) => j.status === 'active' || j.status === 'paused');

    if (activeJobs.length === 0) {
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: '你目前没有活跃的定时任务。' },
        completedAt: Date.now(),
      };
    }

    this.pendingSelections.set(userId, {
      jobs: activeJobs,
      createdAt: Date.now(),
    });

    const lines = ['你有以下活跃的定时任务：', ''];
    for (let i = 0; i < activeJobs.length; i++) {
      const job = activeJobs[i]!;
      const nextRun = new Date(job.nextRunAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      });
      lines.push(`${i + 1}. ${job.description}`);
      lines.push(`   下次执行: ${nextRun}`);
    }
    lines.push('');
    lines.push('请回复数字序号选择要取消的任务，或回复「算了」取消操作。');

    return {
      success: true,
      taskId: generateTaskId(),
      data: { content: lines.join('\n') },
      completedAt: Date.now(),
    };
  }

  processSelection(userId: string, input: string): TaskResult {
    const pending = this.pendingSelections.get(userId);
    if (!pending) {
      return {
        success: false,
        taskId: generateTaskId(),
        error: '没有待处理的取消操作。',
        completedAt: Date.now(),
      };
    }

    // Check TTL
    if (Date.now() - pending.createdAt > TTL_MS) {
      this.pendingSelections.delete(userId);
      return {
        success: false,
        taskId: generateTaskId(),
        error: '操作已超时，请重新发起取消请求。',
        completedAt: Date.now(),
      };
    }

    const trimmed = input.trim();

    // Cancel keywords
    if (CANCEL_KEYWORDS.includes(trimmed)) {
      this.pendingSelections.delete(userId);
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: '已取消操作。' },
        completedAt: Date.now(),
      };
    }

    // Parse number
    const num = Number.parseInt(trimmed, 10);
    if (Number.isNaN(num)) {
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: '请回复数字序号或「算了」。' },
        completedAt: Date.now(),
      };
    }

    if (num < 1 || num > pending.jobs.length) {
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: `请输入 1-${pending.jobs.length} 之间的数字。` },
        completedAt: Date.now(),
      };
    }

    const job = pending.jobs[num - 1]!;

    // Check if job still exists and is active
    const currentJob = this.scheduler.getJob(job.id);
    if (!currentJob || currentJob.status === 'cancelled' || currentJob.status === 'completed') {
      this.pendingSelections.delete(userId);
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: '该任务已不存在或已结束。' },
        completedAt: Date.now(),
      };
    }

    const cancelled = this.scheduler.cancel(job.id);
    this.pendingSelections.delete(userId);

    if (cancelled) {
      this.logger.info('定时任务已取消', { jobId: job.id, userId });
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: `已取消定时任务: ${job.description}` },
        completedAt: Date.now(),
      };
    }

    return {
      success: false,
      taskId: generateTaskId(),
      error: '取消失败，请稍后重试。',
      completedAt: Date.now(),
    };
  }
}
