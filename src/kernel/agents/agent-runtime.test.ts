import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AgentExecuteParams } from '../../shared/agents/agent-instance.types';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import type { TaskClassifier } from '../classifier/task-classifier';
import { AgentRuntime } from './agent-runtime';
import type { ClaudeAgentBridge } from './claude-agent-bridge';
import type { LightLLMClient } from './light-llm-client';

function createMockClassifier(complexity: 'simple' | 'complex' = 'complex'): TaskClassifier {
  return {
    classify: async () => ({
      complexity,
      reason: 'mock',
      confidence: 0.9,
      classifiedBy: 'rule' as const,
      costUsd: 0,
    }),
    ruleClassify: () => null,
    getStats: () => ({
      total: 0,
      ruleClassified: 0,
      llmClassified: 0,
      simpleCount: 0,
      complexCount: 0,
    }),
    resetStats: () => {},
  } as unknown as TaskClassifier;
}

function createMockClaudeBridge(): ClaudeAgentBridge {
  return {
    execute: async () => ({
      content: 'Claude response',
      toolsUsed: [],
      turns: 1,
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    }),
    estimateCost: () => 0.01,
    getActiveSessions: () => 0,
  } as unknown as ClaudeAgentBridge;
}

function createMockLightLLM(): LightLLMClient {
  return {
    complete: async () => ({
      content: 'Light LLM response',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 20, completionTokens: 10, totalCost: 0.001 },
    }),
    stream: async function* () {
      yield { content: 'Light ' };
      yield { content: 'stream' };
      yield { content: '', done: true };
    },
    getDefaultModel: () => 'gpt-4o-mini',
  } as unknown as LightLLMClient;
}

function createParams(overrides: Partial<AgentExecuteParams> = {}): AgentExecuteParams {
  return {
    agentId: 'agent_001',
    context: {
      sessionId: 'sess_001',
      messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
    },
    ...overrides,
  };
}

describe('AgentRuntime', () => {
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

  describe('无依赖（降级模式）', () => {
    test('无分类器时应该默认走 complex 通道', async () => {
      const runtime = new AgentRuntime();
      const result = await runtime.execute(createParams());
      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toContain('未配置');
    });
  });

  describe('分类器路由', () => {
    test('complex 分类应该路由到 Claude Bridge', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('complex'),
        claudeBridge: createMockClaudeBridge(),
      });

      const result = await runtime.execute(createParams());

      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
      expect(result.tokenUsage.inputTokens).toBe(100);
    });

    test('simple 分类应该路由到 LightLLM', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
        lightLLM: createMockLightLLM(),
      });

      const result = await runtime.execute(createParams());

      expect(result.complexity).toBe('simple');
      expect(result.channel).toBe('light_llm');
      expect(result.content).toBe('Light LLM response');
    });

    test('simple 分类但 LightLLM 不可用应该回退到 complex', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
        claudeBridge: createMockClaudeBridge(),
        lightLLM: null,
      });

      const result = await runtime.execute(createParams());

      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
    });
  });

  describe('流式处理', () => {
    test('complex 流式应该通过 Claude Bridge 转发', async () => {
      const mockBridge = createMockClaudeBridge();
      const executeSpy = spyOn(mockBridge, 'execute');
      const streamEvents: StreamEvent[] = [];

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('complex'),
        claudeBridge: mockBridge,
      });

      const params = createParams({
        streamCallback: (e: StreamEvent) => streamEvents.push(e),
      });

      await runtime.execute(params);

      // Verify streamCallback was passed through to bridge
      expect(executeSpy).toHaveBeenCalled();
      const callArgs = executeSpy.mock.calls[0][0];
      expect(callArgs.onStream).toBeDefined();
    });

    test('simple 流式应该通过 LightLLM 转发', async () => {
      const streamEvents: StreamEvent[] = [];

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
        lightLLM: createMockLightLLM(),
      });

      const result = await runtime.execute(
        createParams({
          streamCallback: (e: StreamEvent) => streamEvents.push(e),
        }),
      );

      expect(result.content).toBe('Light stream');
      expect(streamEvents.some((e) => e.type === 'text_delta')).toBe(true);
      expect(streamEvents[streamEvents.length - 1].type).toBe('done');
    });
  });

  describe('无消息时的处理', () => {
    test('无用户消息时应该默认走 complex 通道', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
      });

      const params = createParams();
      params.context.messages = [];

      const result = await runtime.execute(params);
      expect(result.complexity).toBe('complex');
    });
  });

  describe('EnhancedAgentResult 字段', () => {
    test('应该包含 complexity、channel 和 classificationCostUsd', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('complex'),
        claudeBridge: createMockClaudeBridge(),
      });

      const result = await runtime.execute(createParams());

      expect(result).toHaveProperty('complexity');
      expect(result).toHaveProperty('channel');
      expect(result).toHaveProperty('classificationCostUsd');
      expect(typeof result.classificationCostUsd).toBe('number');
    });
  });
});
