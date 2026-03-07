import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Logger } from '../../shared/logging/logger';
import type { ScheduledJob } from './scheduler';

const DEFAULT_STORE_PATH = 'data/scheduler/jobs.json';

export class JobStore {
  private readonly filePath: string;
  private readonly logger = new Logger('JobStore');

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.SCHEDULER_STORE_PATH ?? DEFAULT_STORE_PATH;
  }

  /**
   * Load all persisted jobs from disk. Returns empty array if file doesn't exist.
   */
  load(): ScheduledJob[] {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const jobs = JSON.parse(raw) as ScheduledJob[];
      this.logger.info('Jobs 已从磁盘加载', { count: jobs.length });
      return jobs;
    } catch (error) {
      this.logger.error('Jobs 加载失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Save jobs to disk. Cancelled jobs are filtered out before writing.
   */
  save(jobs: ScheduledJob[]): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const filtered = jobs.filter((j) => j.status !== 'cancelled');
      writeFileSync(this.filePath, JSON.stringify(filtered, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Jobs 持久化失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
