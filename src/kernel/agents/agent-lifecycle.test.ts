import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ClassifyResult } from '../classifier/classifier-types';
import { AgentLifecycleManager } from './agent-lifecycle';

function createClassifyResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    complexity: 'complex',
    reason: 'test',
    confidence: 0.9,
    classifiedBy: 'rule',
    costUsd: 0,
    ...overrides,
  };
}

describe('AgentLifecycleManager', () => {
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

  describe('startLifecycle', () => {
    test('应该创建生命周期上下文并进入 CLASSIFYING 状态', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');

      expect(ctx.requestId).toMatch(/^req_/);
      expect(ctx.sessionId).toBe('sess_001');
      expect(ctx.state).toBe('CLASSIFYING');
      expect(ctx.channel).toBeNull();
      expect(ctx.classificationResult).toBeNull();
      expect(ctx.startedAt).toBeGreaterThan(0);
    });
  });

  describe('markClassified', () => {
    test('complex 分类应该转换到 AGENT_SDK_PROCESSING', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');
      const result = createClassifyResult({ complexity: 'complex' });

      const updated = manager.markClassified(ctx.requestId, result);

      expect(updated.state).toBe('AGENT_SDK_PROCESSING');
      expect(updated.channel).toBe('agent_sdk');
      expect(updated.classificationResult).toBe(result);
    });

    test('simple 分类应该转换到 LIGHT_LLM_PROCESSING', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');
      const result = createClassifyResult({ complexity: 'simple' });

      const updated = manager.markClassified(ctx.requestId, result);

      expect(updated.state).toBe('LIGHT_LLM_PROCESSING');
      expect(updated.channel).toBe('light_llm');
    });
  });

  describe('完整生命周期 - complex 路径', () => {
    test('IDLE → CLASSIFYING → AGENT_SDK_PROCESSING → COMPLETING → COMPLETED', () => {
      const manager = new AgentLifecycleManager();
      const transitions: Array<{ from: string; to: string }> = [];

      manager.on('lifecycle:transition', (event) => {
        transitions.push({ from: event.from, to: event.to });
      });

      const ctx = manager.startLifecycle('sess_001', 'Hello');
      manager.markClassified(ctx.requestId, createClassifyResult({ complexity: 'complex' }));
      manager.markCompleting(ctx.requestId);
      manager.markCompleted(ctx.requestId);

      expect(transitions.map((t) => t.to)).toEqual([
        'CLASSIFYING',
        'AGENT_SDK_PROCESSING',
        'COMPLETING',
        'COMPLETED',
      ]);
      expect(ctx.state).toBe('COMPLETED');
      expect(ctx.completedAt).toBeGreaterThan(0);
    });
  });

  describe('完整生命周期 - simple 路径', () => {
    test('IDLE → CLASSIFYING → LIGHT_LLM_PROCESSING → COMPLETING → COMPLETED', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hi');
      manager.markClassified(ctx.requestId, createClassifyResult({ complexity: 'simple' }));
      manager.markCompleting(ctx.requestId);
      manager.markCompleted(ctx.requestId);

      expect(ctx.state).toBe('COMPLETED');
      expect(ctx.channel).toBe('light_llm');
    });
  });

  describe('错误处理', () => {
    test('markError 应该转换到 ERROR 状态', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');

      manager.markError(ctx.requestId, 'API 超时');

      expect(ctx.state).toBe('ERROR');
      expect(ctx.error).toBe('API 超时');
      expect(ctx.completedAt).toBeGreaterThan(0);
    });

    test('应该发射 lifecycle:metrics 事件', () => {
      const manager = new AgentLifecycleManager();
      let metricsEvent: unknown = null;

      manager.on('lifecycle:metrics', (metrics) => {
        metricsEvent = metrics;
      });

      const ctx = manager.startLifecycle('sess_001', 'Hello');
      manager.markError(ctx.requestId, 'error');

      expect(metricsEvent).not.toBeNull();
      expect((metricsEvent as Record<string, unknown>).success).toBe(false);
    });
  });

  describe('abortLifecycle', () => {
    test('应该中止活跃的生命周期', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');

      const result = manager.abortLifecycle(ctx.requestId);

      expect(result).toBe(true);
      expect(ctx.state).toBe('ERROR');
      expect(ctx.error).toContain('取消');
    });

    test('应该对已完成的生命周期返回 false', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');
      manager.markClassified(ctx.requestId, createClassifyResult({ complexity: 'simple' }));
      manager.markCompleting(ctx.requestId);
      manager.markCompleted(ctx.requestId);

      const result = manager.abortLifecycle(ctx.requestId);
      expect(result).toBe(false);
    });

    test('应该对不存在的请求返回 false', () => {
      const manager = new AgentLifecycleManager();
      expect(manager.abortLifecycle('nonexistent')).toBe(false);
    });
  });

  describe('getActiveCount', () => {
    test('应该返回活跃的生命周期数量', () => {
      const manager = new AgentLifecycleManager();
      expect(manager.getActiveCount()).toBe(0);

      const ctx1 = manager.startLifecycle('sess_001', 'Hello');
      expect(manager.getActiveCount()).toBe(1);

      const _ctx2 = manager.startLifecycle('sess_002', 'Hi');
      expect(manager.getActiveCount()).toBe(2);

      manager.markClassified(ctx1.requestId, createClassifyResult({ complexity: 'simple' }));
      manager.markCompleting(ctx1.requestId);
      manager.markCompleted(ctx1.requestId);
      expect(manager.getActiveCount()).toBe(1);
    });
  });

  describe('无效状态转换', () => {
    test('应该忽略无效的状态转换', () => {
      const manager = new AgentLifecycleManager();
      const ctx = manager.startLifecycle('sess_001', 'Hello');
      manager.markClassified(ctx.requestId, createClassifyResult({ complexity: 'complex' }));
      manager.markCompleting(ctx.requestId);
      manager.markCompleted(ctx.requestId);

      // COMPLETED → CLASSIFYING is invalid, state should remain COMPLETED
      manager.transitionTo(ctx, 'CLASSIFYING');
      expect(ctx.state).toBe('COMPLETED');
    });
  });

  describe('metrics 事件', () => {
    test('完成时应该发射 lifecycle:metrics', () => {
      const manager = new AgentLifecycleManager();
      let metricsEvent: unknown = null;
      manager.on('lifecycle:metrics', (m) => {
        metricsEvent = m;
      });

      const ctx = manager.startLifecycle('sess_001', 'Hello');
      manager.markClassified(ctx.requestId, createClassifyResult({ complexity: 'complex' }));
      manager.markCompleting(ctx.requestId);
      manager.markCompleted(ctx.requestId);

      expect(metricsEvent).not.toBeNull();
      const m = metricsEvent as Record<string, unknown>;
      expect(m.requestId).toBe(ctx.requestId);
      expect(m.sessionId).toBe('sess_001');
      expect(m.success).toBe(true);
      expect(m.channel).toBe('agent_sdk');
      expect(m.complexity).toBe('complex');
      expect(typeof m.totalDurationMs).toBe('number');
    });
  });
});
