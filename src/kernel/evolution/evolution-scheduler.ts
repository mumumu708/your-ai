import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import {
  type LlmDistillFn,
  clusterItemsWithOV,
  distillClusters,
  scanUndigested,
  writeInsights,
} from './digest/digest-pipeline';
import { evolveMemory } from './evolve';
import { linkMemory } from './link';
import { type ReflectLlmCall, reflect } from './reflect';

const logger = new Logger('EvolutionScheduler');

interface EvolutionJob {
  type: 'reflect' | 'link' | 'evolve' | 'digest';
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

  constructor(
    private readonly ov: OpenVikingClient,
    private readonly reflectLlmCall?: ReflectLlmCall,
    private readonly digestLlmDistill?: LlmDistillFn,
  ) {}

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

  /** Schedule a digest task (DD-022) */
  scheduleDigest(userId: string): void {
    this.enqueue({
      type: 'digest',
      payload: { userId },
      retries: 0,
    });
    logger.info('消化任务已调度', { userId });
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
      const job = this.pending.shift();
      if (!job) break;
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
          await reflect(this.ov, job.payload.category as string, this.reflectLlmCall);
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
        case 'digest':
          await this.executeDigest(job.payload.userId as string);
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

  /** DD-022: Execute digest pipeline — scan → cluster → distill → write */
  private async executeDigest(userId: string): Promise<void> {
    if (!this.digestLlmDistill) {
      logger.warn('Digest 跳过：未注入 LLM distill 函数', { userId });
      return;
    }

    const items = await scanUndigested(this.ov, userId);
    if (items.length === 0) {
      logger.info('Digest 跳过：无未消化碎片', { userId });
      return;
    }

    const clusters = await clusterItemsWithOV(items, this.ov);
    if (clusters.length === 0) {
      logger.info('Digest 跳过：聚类结果为空', { userId, scanned: items.length });
      return;
    }

    const insights = await distillClusters(clusters, this.digestLlmDistill);
    const written = await writeInsights(this.ov, userId, insights);
    logger.info('Digest 完成', {
      userId,
      scanned: items.length,
      clusters: clusters.length,
      written,
    });
  }
}
