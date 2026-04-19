import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AgentExecuteParams } from '../../shared/agents/agent-instance.types';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import type { TaskClassifier } from '../classifier/task-classifier';
import type { AgentBridge } from './agent-bridge';
import { AgentRuntime } from './agent-runtime';
import type { LightLLMClient } from './light-llm-client';

function createMockClassifier(complexity: 'simple' | 'complex' = 'complex'): TaskClassifier {
  return {
    classify: async () => ({
      taskType: 'chat' as const,
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

function createMockAgentBridge(): AgentBridge {
  return {
    execute: async () => ({
      content: 'Claude response',
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolsUsed: [],
      finishedNaturally: true,
      handledBy: 'claude' as const,
    }),
  };
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
    test('complex 分类应该路由到 Agent Bridge', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('complex'),
        agentBridge: createMockAgentBridge(),
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
        agentBridge: createMockAgentBridge(),
        lightLLM: null,
      });

      const result = await runtime.execute(createParams());

      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
    });
  });

  describe('流式处理', () => {
    test('complex 流式应该通过 Agent Bridge 转发', async () => {
      const mockBridge = createMockAgentBridge();
      const executeSpy = spyOn(mockBridge, 'execute');
      const streamEvents: StreamEvent[] = [];

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('complex'),
        agentBridge: mockBridge,
      });

      const params = createParams({
        streamCallback: (e: StreamEvent) => streamEvents.push(e),
      });

      await runtime.execute(params);

      // Verify streamCallback was passed through to bridge
      expect(executeSpy).toHaveBeenCalled();
      const callArgs = executeSpy.mock.calls[0][0];
      expect(callArgs.streamCallback).toBeDefined();
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

  describe('forceComplex (harness 模式)', () => {
    test('forceComplex 应绕过分类器直接走 Agent Bridge', async () => {
      const mockBridge = createMockAgentBridge();
      const executeSpy = spyOn(mockBridge, 'execute');

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'), // Would normally go to LightLLM
        agentBridge: mockBridge,
        lightLLM: createMockLightLLM(),
      });

      const result = await runtime.execute(createParams({ forceComplex: true }));

      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('EnhancedAgentResult 字段', () => {
    test('应该包含 complexity、channel 和 classificationCostUsd', async () => {
      const runtime = new AgentRuntime({
        classifier: createMockClassifier('complex'),
        agentBridge: createMockAgentBridge(),
      });

      const result = await runtime.execute(createParams());

      expect(result).toHaveProperty('complexity');
      expect(result).toHaveProperty('channel');
      expect(result).toHaveProperty('classificationCostUsd');
      expect(typeof result.classificationCostUsd).toBe('number');
    });
  });

  describe('预计算 classifyResult', () => {
    test('传入 classifyResult 为 simple 时直接路由到 LightLLM，不调用 classifier', async () => {
      const mockClassifier = createMockClassifier('complex'); // Would route to complex
      const classifySpy = spyOn(mockClassifier, 'classify');

      const runtime = new AgentRuntime({
        classifier: mockClassifier,
        agentBridge: createMockAgentBridge(),
        lightLLM: createMockLightLLM(),
      });

      const result = await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'pre-computed',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0.001,
          },
        }),
      );

      expect(classifySpy).not.toHaveBeenCalled();
      expect(result.complexity).toBe('simple');
      expect(result.channel).toBe('light_llm');
      expect(result.classificationCostUsd).toBe(0.001);
    });

    test('传入 classifyResult 为 complex 时直接路由到 Agent Bridge，不调用 classifier', async () => {
      const mockClassifier = createMockClassifier('simple'); // Would route to simple
      const classifySpy = spyOn(mockClassifier, 'classify');

      const runtime = new AgentRuntime({
        classifier: mockClassifier,
        agentBridge: createMockAgentBridge(),
        lightLLM: createMockLightLLM(),
      });

      const result = await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'harness',
            complexity: 'complex',
            reason: 'pre-computed harness',
            confidence: 0.95,
            classifiedBy: 'llm',
            costUsd: 0.002,
          },
        }),
      );

      expect(classifySpy).not.toHaveBeenCalled();
      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
    });

    test('无 classifyResult 时应该 fallback 到 classifier', async () => {
      const mockClassifier = createMockClassifier('complex');
      const classifySpy = spyOn(mockClassifier, 'classify');

      const runtime = new AgentRuntime({
        classifier: mockClassifier,
        agentBridge: createMockAgentBridge(),
      });

      await runtime.execute(createParams());

      expect(classifySpy).toHaveBeenCalledTimes(1);
    });

    test('forceComplex 应优先于 classifyResult', async () => {
      const runtime = new AgentRuntime({
        agentBridge: createMockAgentBridge(),
        lightLLM: createMockLightLLM(),
      });

      const result = await runtime.execute(
        createParams({
          forceComplex: true,
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'should be overridden',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0,
          },
        }),
      );

      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
    });
  });

  describe('LightLLM 失败降级到 Agent Bridge', () => {
    test('classifyResult=simple 但 LightLLM 抛异常时应降级到 Agent Bridge', async () => {
      const failingLLM = {
        complete: async () => {
          throw new Error('LightLLM API 错误: 429');
        },
        // biome-ignore lint/correctness/useYield: test mock intentionally throws without yielding
        stream: async function* () {
          throw new Error('LightLLM stream API 错误: 429');
        },
        getDefaultModel: () => 'gpt-4o-mini',
      } as unknown as LightLLMClient;

      const runtime = new AgentRuntime({
        agentBridge: createMockAgentBridge(),
        lightLLM: failingLLM,
      });

      const result = await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'test',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0,
          },
        }),
      );

      // Should have fallen back to Agent Bridge instead of throwing
      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
    });

    test('classifyResult=simple + stream 模式 LightLLM 429 应降级到 Agent Bridge', async () => {
      const streamEvents: StreamEvent[] = [];
      const failingLLM = {
        complete: async () => {
          throw new Error('LightLLM API 错误: 429');
        },
        // biome-ignore lint/correctness/useYield: test mock intentionally throws without yielding
        stream: async function* () {
          throw new Error('LightLLM stream API 错误: 429');
        },
        getDefaultModel: () => 'gpt-4o-mini',
      } as unknown as LightLLMClient;

      const runtime = new AgentRuntime({
        agentBridge: createMockAgentBridge(),
        lightLLM: failingLLM,
      });

      const result = await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'test',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0,
          },
          streamCallback: (e: StreamEvent) => streamEvents.push(e),
        }),
      );

      expect(result.complexity).toBe('complex');
      expect(result.channel).toBe('agent_sdk');
      expect(result.content).toBe('Claude response');
    });
  });

  describe('多模态消息 (mediaRefs)', () => {
    test('simple 路径应构造 content array 含图片', async () => {
      let capturedMessages: unknown[] = [];
      const mockLLM = {
        complete: async (req: { messages: unknown[] }) => {
          capturedMessages = req.messages;
          return {
            content: '这是一只猫',
            model: 'gpt-4o-mini',
            usage: { promptTokens: 100, completionTokens: 20, totalCost: 0.001 },
          };
        },
        stream: async function* () {
          yield { content: '', done: true };
        },
        getDefaultModel: () => 'gpt-4o-mini',
      } as unknown as LightLLMClient;

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
        lightLLM: mockLLM,
      });

      const result = await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'test',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0,
          },
          context: {
            sessionId: 'sess_media',
            messages: [
              {
                role: 'user',
                content: '看看这张图片',
                timestamp: Date.now(),
                mediaRefs: [
                  {
                    mediaType: 'image',
                    mimeType: 'image/jpeg',
                    description: '一只猫',
                    base64Data: 'dGVzdA==',
                  },
                ],
              },
            ],
          },
        }),
      );

      expect(result.content).toBe('这是一只猫');
      // Verify the user message was constructed as multimodal content array
      const userMsg = capturedMessages.find(
        (m: unknown) => (m as { role: string }).role === 'user',
      ) as { content: unknown };
      expect(Array.isArray(userMsg.content)).toBe(true);
      const parts = userMsg.content as Array<{ type: string }>;
      expect(parts[0]?.type).toBe('text');
      expect(parts[1]?.type).toBe('image_url');
    });

    test('simple 路径应从 localPath 恢复 base64（base64 被清空后）', async () => {
      // 准备：写一个临时文件模拟持久化的图片
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const tmpDir = mkdtempSync(join(tmpdir(), 'rt-test-'));
      const imgPath = join(tmpDir, 'test.jpg');
      const imgBuffer = Buffer.from('fake-image-data');
      writeFileSync(imgPath, imgBuffer);

      let capturedMessages: unknown[] = [];
      const mockLLM = {
        complete: async (req: { messages: unknown[] }) => {
          capturedMessages = req.messages;
          return {
            content: '从磁盘恢复的图片',
            model: 'gpt-4o-mini',
            usage: { promptTokens: 100, completionTokens: 20, totalCost: 0.001 },
          };
        },
        stream: async function* () {
          yield { content: '', done: true };
        },
        getDefaultModel: () => 'gpt-4o-mini',
      } as unknown as LightLLMClient;

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
        lightLLM: mockLLM,
      });

      await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'test',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0,
          },
          context: {
            sessionId: 'sess_recover',
            messages: [
              {
                role: 'user',
                content: '之前发的图片',
                timestamp: Date.now(),
                mediaRefs: [
                  {
                    mediaType: 'image',
                    mimeType: 'image/jpeg',
                    description: '测试图',
                    // base64Data 已被清空，只有 localPath
                    localPath: imgPath,
                  },
                ],
              },
            ],
          },
        }),
      );

      // 应该从 localPath 恢复了 base64，构造了 multimodal content
      const userMsg = capturedMessages.find(
        (m: unknown) => (m as { role: string }).role === 'user',
      ) as { content: unknown };
      expect(Array.isArray(userMsg.content)).toBe(true);
      const parts = userMsg.content as Array<{ type: string }>;
      expect(parts.some((p) => p.type === 'image_url')).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    test('simple 路径无 mediaRefs 保持字符串 content', async () => {
      let capturedMessages: unknown[] = [];
      const mockLLM = {
        complete: async (req: { messages: unknown[] }) => {
          capturedMessages = req.messages;
          return {
            content: 'response',
            model: 'gpt-4o-mini',
            usage: { promptTokens: 20, completionTokens: 10, totalCost: 0.001 },
          };
        },
        stream: async function* () {
          yield { content: '', done: true };
        },
        getDefaultModel: () => 'gpt-4o-mini',
      } as unknown as LightLLMClient;

      const runtime = new AgentRuntime({
        classifier: createMockClassifier('simple'),
        lightLLM: mockLLM,
      });

      await runtime.execute(
        createParams({
          classifyResult: {
            taskType: 'chat',
            complexity: 'simple',
            reason: 'test',
            confidence: 0.9,
            classifiedBy: 'rule',
            costUsd: 0,
          },
        }),
      );

      const userMsg = capturedMessages.find(
        (m: unknown) => (m as { role: string }).role === 'user',
      ) as { content: unknown };
      expect(typeof userMsg.content).toBe('string');
    });
  });
});
