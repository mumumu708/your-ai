import { Logger } from '../../shared/logging/logger';
import type { ChannelType } from '../../shared/messaging';
import type { TaskResult } from '../../shared/tasking/task-result.types';
import { generateId } from '../../shared/utils/crypto';
import { CronParser } from './cron-parser';
import type { JobStore } from './job-store';

// --- Types ---

export interface ScheduleConfig {
  cronExpression: string;
  taskTemplate: Record<string, unknown>;
  userId: string;
  description?: string;
  channel?: ChannelType;
}

export type JobStatus = 'active' | 'paused' | 'cancelled';

export interface ScheduledJob {
  id: string;
  cronExpression: string;
  taskTemplate: Record<string, unknown>;
  userId: string;
  description: string;
  channel: ChannelType;
  status: JobStatus;
  nextRunAt: number;
  createdAt: number;
  executionCount: number;
  lastRunAt?: number;
  lastResult: TaskResult | null;
}

export type JobExecutor = (job: ScheduledJob) => Promise<TaskResult>;

// --- Scheduler ---

export class Scheduler {
  private readonly logger = new Logger('Scheduler');
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly store: JobStore | null;
  private executor: JobExecutor | null = null;
  private running = false;

  constructor(store?: JobStore) {
    this.store = store ?? null;
  }

  /**
   * Set the executor callback for when jobs trigger.
   * Typically set by CentralController to route back through orchestrate().
   */
  setExecutor(executor: JobExecutor): void {
    this.executor = executor;
  }

  /**
   * Register a new scheduled job. Returns the job ID.
   */
  async register(config: ScheduleConfig): Promise<string> {
    const jobId = generateId('job');
    const nextRunAt = this.calculateNextRun(config.cronExpression);

    const job: ScheduledJob = {
      id: jobId,
      cronExpression: config.cronExpression,
      taskTemplate: config.taskTemplate,
      userId: config.userId,
      description: config.description ?? '',
      channel: config.channel ?? 'api',
      status: 'active',
      nextRunAt,
      createdAt: Date.now(),
      executionCount: 0,
      lastResult: null,
    };

    this.jobs.set(jobId, job);
    this.persistJobs();
    this.logger.info('Job 已注册', { jobId, cron: config.cronExpression, nextRunAt });

    if (this.running) {
      this.scheduleNextRun(job);
    }

    return jobId;
  }

  /**
   * Start the scheduler. Begins scheduling timers for all active jobs.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('Scheduler 已启动');

    for (const job of this.jobs.values()) {
      if (job.status === 'active') {
        this.scheduleNextRun(job);
      }
    }
  }

  /**
   * Stop the scheduler. Clears all pending timers.
   */
  stop(): void {
    this.running = false;
    for (const [jobId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.logger.info('Scheduler 已停止');
  }

  /**
   * Pause a specific job.
   */
  pause(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'active') return false;

    job.status = 'paused';
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.persistJobs();
    this.logger.info('Job 已暂停', { jobId });
    return true;
  }

  /**
   * Resume a paused job.
   */
  resume(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'paused') return false;

    job.status = 'active';
    job.nextRunAt = this.calculateNextRun(job.cronExpression);
    if (this.running) {
      this.scheduleNextRun(job);
    }
    this.persistJobs();
    this.logger.info('Job 已恢复', { jobId });
    return true;
  }

  /**
   * Cancel a job permanently.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.status = 'cancelled';
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.persistJobs();
    this.logger.info('Job 已取消', { jobId });
    return true;
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): ScheduledJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * List all jobs, optionally filtered by userId.
   */
  listJobs(userId?: string): ScheduledJob[] {
    const all = Array.from(this.jobs.values());
    return userId ? all.filter((j) => j.userId === userId) : all;
  }

  /**
   * Get count of registered jobs.
   */
  getJobCount(): number {
    return this.jobs.size;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Load jobs from persistent store into memory.
   */
  async loadJobs(): Promise<void> {
    if (!this.store) return;
    const jobs = this.store.load();
    for (const job of jobs) {
      this.jobs.set(job.id, job);
    }
    this.logger.info('Jobs 已加载', { count: jobs.length });
  }

  /**
   * Persist current jobs to store (filters out cancelled).
   */
  persistJobs(): void {
    if (!this.store) return;
    this.store.save(Array.from(this.jobs.values()));
  }

  // --- Private ---

  private scheduleNextRun(job: ScheduledJob): void {
    const delay = job.nextRunAt - Date.now();

    if (delay <= 0) {
      // Past due, execute immediately
      this.executeJob(job);
      return;
    }

    const timer = setTimeout(() => this.executeJob(job), delay);
    this.timers.set(job.id, timer);
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    if (job.status !== 'active') return;

    job.executionCount++;
    job.lastRunAt = Date.now();
    this.timers.delete(job.id);

    this.logger.info('Job 执行', {
      jobId: job.id,
      executionCount: job.executionCount,
    });

    try {
      if (this.executor) {
        job.lastResult = await this.executor(job);
      } else {
        this.logger.error('无 executor，跳过执行', { jobId: job.id });
        job.lastResult = {
          success: false,
          taskId: job.id,
          error: 'No executor configured',
          completedAt: Date.now(),
        };
      }
    } catch (error) {
      this.logger.error('Job 执行失败', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      job.lastResult = {
        success: false,
        taskId: job.id,
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      };
    }

    this.persistJobs();

    // Schedule next run if still active
    if (job.status === 'active' && this.running) {
      job.nextRunAt = this.calculateNextRun(job.cronExpression);
      this.scheduleNextRun(job);
    }
  }

  private calculateNextRun(cronExpression: string): number {
    if (!cronExpression) {
      // No cron expression (one-shot or manual), return far future
      return Date.now() + 365 * 24 * 60 * 60 * 1000;
    }

    const next = CronParser.nextRun(cronExpression);
    return next ? next.getTime() : Date.now() + 365 * 24 * 60 * 60 * 1000;
  }
}
