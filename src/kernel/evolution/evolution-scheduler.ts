import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import { reflect } from './reflect';
import { linkMemory } from './link';
import { evolveMemory } from './evolve';

const logger = new Logger('EvolutionScheduler');

interface EvolutionJob {
  type: 'reflect' | 'link' | 'evolve';
  payload: Record<string, unknown>;
  retries: number;
}

/**
 * Simple async scheduler for memory evolution tasks.
 * Concurrency=2, retries=1. Jobs run in background and don't block callers.
 */
export class EvolutionScheduler {
  private readonly maxConcurrency = 2;
  private readonly maxRetries = 1;
  private running = 0;
  private readonly pending: EvolutionJob[] = [];

  constructor(private readonly ov: OpenVikingClient) {}

  /** Schedule post-commit evolution tasks for extracted memories */
  schedulePostCommit(extractedMemoryUris: string[]): void {
    for (const uri of extractedMemoryUris) {
      this.enqueue({ type: 'link', payload: { uri }, retries: 0 });
    }

    // Schedule reflection for common categories
    for (const category of ['facts', 'preferences', 'procedures']) {
      this.enqueue({ type: 'reflect', payload: { category }, retries: 0 });
    }

    logger.info('进化任务已调度', {
      links: extractedMemoryUris.length,
      reflects: 3,
    });
  }

  /** Schedule a single evolve task */
  scheduleEvolve(newContent: string, existingUri: string): void {
    this.enqueue({
      type: 'evolve',
      payload: { newContent, existingUri },
      retries: 0,
    });
  }

  private enqueue(job: EvolutionJob): void {
    this.pending.push(job);
    this.drain();
  }

  private drain(): void {
    while (this.running < this.maxConcurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.running++;
      this.executeJob(job).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  private async executeJob(job: EvolutionJob): Promise<void> {
    try {
      switch (job.type) {
        case 'reflect':
          await reflect(this.ov, job.payload.category as string);
          break;
        case 'link':
          await linkMemory(this.ov, job.payload.uri as string);
          break;
        case 'evolve':
          await evolveMemory(
            this.ov,
            job.payload.newContent as string,
            job.payload.existingUri as string,
          );
          break;
      }
    } catch (err) {
      logger.error('进化任务失败', {
        type: job.type,
        retries: job.retries,
        error: err instanceof Error ? err.message : String(err),
      });
      if (job.retries < this.maxRetries) {
        this.enqueue({ ...job, retries: job.retries + 1 });
      }
    }
  }
}
