import { EventEmitter } from 'node:events';
import { Logger } from '../../shared/logging/logger';
import { generateId } from '../../shared/utils/crypto';
import type { ClassifyResult } from '../classifier/classifier-types';

export type LifecycleState =
  | 'IDLE'
  | 'CLASSIFYING'
  | 'AGENT_SDK_PROCESSING'
  | 'LIGHT_LLM_PROCESSING'
  | 'COMPLETING'
  | 'COMPLETED'
  | 'ERROR';

export interface LifecycleContext {
  sessionId: string;
  requestId: string;
  state: LifecycleState;
  channel: 'agent_sdk' | 'light_llm' | null;
  classificationResult: ClassifyResult | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
}

export interface LifecycleMetrics {
  requestId: string;
  sessionId: string;
  totalDurationMs: number;
  classificationDurationMs: number;
  processingDurationMs: number;
  channel: string | null;
  complexity: string | null;
  success: boolean;
}

const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  IDLE: ['CLASSIFYING', 'ERROR'],
  CLASSIFYING: ['AGENT_SDK_PROCESSING', 'LIGHT_LLM_PROCESSING', 'ERROR'],
  AGENT_SDK_PROCESSING: ['COMPLETING', 'ERROR'],
  LIGHT_LLM_PROCESSING: ['COMPLETING', 'ERROR'],
  COMPLETING: ['COMPLETED', 'ERROR'],
  COMPLETED: [],
  ERROR: [],
};

export class AgentLifecycleManager extends EventEmitter {
  private readonly logger = new Logger('AgentLifecycleManager');
  private readonly contexts: Map<string, LifecycleContext> = new Map();
  private classificationTimestamps: Map<string, number> = new Map();

  startLifecycle(sessionId: string, _userMessage: string): LifecycleContext {
    const requestId = generateId('req');
    const context: LifecycleContext = {
      sessionId,
      requestId,
      state: 'IDLE',
      channel: null,
      classificationResult: null,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };

    this.contexts.set(requestId, context);
    this.logger.info('生命周期启动', { requestId, sessionId });

    this.transitionTo(context, 'CLASSIFYING');
    this.classificationTimestamps.set(requestId, Date.now());

    return context;
  }

  markClassified(requestId: string, result: ClassifyResult): LifecycleContext {
    const ctx = this.getContext(requestId);

    ctx.classificationResult = result;
    const nextState: LifecycleState =
      result.complexity === 'complex' ? 'AGENT_SDK_PROCESSING' : 'LIGHT_LLM_PROCESSING';
    ctx.channel = result.complexity === 'complex' ? 'agent_sdk' : 'light_llm';

    this.transitionTo(ctx, nextState);
    return ctx;
  }

  markCompleting(requestId: string): LifecycleContext {
    const ctx = this.getContext(requestId);
    this.transitionTo(ctx, 'COMPLETING');
    return ctx;
  }

  markCompleted(requestId: string): LifecycleContext {
    const ctx = this.getContext(requestId);
    ctx.completedAt = Date.now();
    this.transitionTo(ctx, 'COMPLETED');

    const metrics = this.recordMetrics(ctx);
    this.emit('lifecycle:metrics', metrics);

    return ctx;
  }

  markError(requestId: string, error: string): LifecycleContext {
    const ctx = this.getContext(requestId);
    ctx.error = error;
    ctx.completedAt = Date.now();

    // Force transition to ERROR (always valid)
    const from = ctx.state;
    ctx.state = 'ERROR';
    this.emit('lifecycle:transition', {
      requestId,
      from,
      to: 'ERROR',
      timestamp: Date.now(),
    });

    const metrics = this.recordMetrics(ctx);
    this.emit('lifecycle:metrics', metrics);

    this.logger.error('生命周期错误', { requestId, error });
    return ctx;
  }

  abortLifecycle(requestId: string): boolean {
    const ctx = this.contexts.get(requestId);
    if (!ctx || ctx.state === 'COMPLETED' || ctx.state === 'ERROR') {
      return false;
    }

    this.markError(requestId, '用户取消');
    this.logger.info('生命周期中止', { requestId });
    return true;
  }

  transitionTo(ctx: LifecycleContext, newState: LifecycleState): void {
    const validTargets = VALID_TRANSITIONS[ctx.state];
    if (!validTargets.includes(newState)) {
      this.logger.warn('无效状态转换', {
        requestId: ctx.requestId,
        from: ctx.state,
        to: newState,
      });
      return;
    }

    const from = ctx.state;
    ctx.state = newState;

    this.emit('lifecycle:transition', {
      requestId: ctx.requestId,
      from,
      to: newState,
      timestamp: Date.now(),
    });

    this.logger.debug('状态转换', {
      requestId: ctx.requestId,
      from,
      to: newState,
    });
  }

  private recordMetrics(ctx: LifecycleContext): LifecycleMetrics {
    const now = ctx.completedAt ?? Date.now();
    const classifyTs = this.classificationTimestamps.get(ctx.requestId);
    const classificationDurationMs = classifyTs
      ? (ctx.classificationResult ? Date.now() : now) - classifyTs
      : 0;

    return {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      totalDurationMs: now - ctx.startedAt,
      classificationDurationMs,
      processingDurationMs: now - ctx.startedAt - classificationDurationMs,
      channel: ctx.channel,
      complexity: ctx.classificationResult?.complexity ?? null,
      success: ctx.state === 'COMPLETED',
    };
  }

  private getContext(requestId: string): LifecycleContext {
    const ctx = this.contexts.get(requestId);
    if (!ctx) {
      throw new Error(`生命周期上下文不存在: ${requestId}`);
    }
    return ctx;
  }

  getActiveCount(): number {
    let count = 0;
    for (const ctx of this.contexts.values()) {
      if (ctx.state !== 'COMPLETED' && ctx.state !== 'ERROR') {
        count++;
      }
    }
    return count;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, ctx] of this.contexts) {
      if (
        (ctx.state === 'COMPLETED' || ctx.state === 'ERROR') &&
        ctx.completedAt &&
        now - ctx.completedAt > 300_000 // 5 minutes
      ) {
        this.contexts.delete(id);
        this.classificationTimestamps.delete(id);
      }
    }
  }
}
