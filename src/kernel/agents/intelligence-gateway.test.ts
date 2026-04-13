import { describe, expect, test } from 'bun:test';
import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';
import type { GatewayHandleParams, LightLlmCompletable } from './intelligence-gateway';
import { IntelligenceGateway } from './intelligence-gateway';

function makeAgentParams(overrides: Partial<AgentExecuteParams> = {}): AgentExecuteParams {
  return {
    systemPrompt: 'test',
    prependContext: '',
    userMessage: 'hello',
    sessionId: 'sess-1',
    executionMode: 'sync',
    ...overrides,
  };
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    content: 'agent response',
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    finishedNaturally: true,
    handledBy: 'claude',
    ...overrides,
  };
}

function createMockLightLlm(content = 'light response'): LightLlmCompletable {
  return {
    complete: async () => ({
      content,
      usage: { promptTokens: 10, completionTokens: 5 },
    }),
  };
}

function createMockAgent(overrides: Partial<AgentBridge> = {}): AgentBridge {
  return {
    execute: async () => makeAgentResult(),
    ...overrides,
  };
}

function makeGatewayParams(overrides: Partial<GatewayHandleParams> = {}): GatewayHandleParams {
  return {
    message: 'hello',
    complexity: 'simple',
    taskType: 'chat',
    hasAttachments: false,
    agentParams: makeAgentParams(),
    ...overrides,
  };
}

describe('IntelligenceGateway', () => {
  describe('canHandleDirectly', () => {
    test('简单 chat 无附件无工具需求 → 直接处理', () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      const params = makeGatewayParams({ message: '你好' });
      expect(gw.canHandleDirectly(params)).toBe(true);
    });

    test('complex 任务 → 不直接处理', () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      const params = makeGatewayParams({ complexity: 'complex' });
      expect(gw.canHandleDirectly(params)).toBe(false);
    });

    test('非 chat 任务类型 → 不直接处理', () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      const params = makeGatewayParams({ taskType: 'harness' });
      expect(gw.canHandleDirectly(params)).toBe(false);
    });

    test('有附件 → 不直接处理', () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      const params = makeGatewayParams({ hasAttachments: true });
      expect(gw.canHandleDirectly(params)).toBe(false);
    });

    test('消息可能需要工具 → 不直接处理', () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      const params = makeGatewayParams({ message: '帮我搜索一下最新的新闻' });
      expect(gw.canHandleDirectly(params)).toBe(false);
    });

    test('消息可能需要记忆 → 不直接处理', () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      const params = makeGatewayParams({ message: '我们之前讨论过什么' });
      expect(gw.canHandleDirectly(params)).toBe(false);
    });
  });

  describe('handle — 直接处理', () => {
    test('简单任务使用 LightLLM 快速回答', async () => {
      const gw = new IntelligenceGateway(
        createMockLightLlm('你好！有什么可以帮你的？'),
        createMockAgent(),
      );
      const result = await gw.handle(makeGatewayParams({ message: '你好' }));

      expect(result.content).toBe('你好！有什么可以帮你的？');
      expect(result.handledBy).toBe('gateway');
      expect(result.finishedNaturally).toBe(true);
      expect(result.tokenUsage.inputTokens).toBe(10);
      expect(result.tokenUsage.outputTokens).toBe(5);
    });

    test('LightLLM 返回空 usage 时 token 为 0', async () => {
      const lightLlm: LightLlmCompletable = {
        complete: async () => ({ content: 'ok' }),
      };
      const gw = new IntelligenceGateway(lightLlm, createMockAgent());
      const result = await gw.handle(makeGatewayParams({ message: 'hi' }));

      expect(result.tokenUsage.inputTokens).toBe(0);
      expect(result.tokenUsage.outputTokens).toBe(0);
    });
  });

  describe('handle — 下沉到 Agent Layer', () => {
    test('复杂任务委托给 AgentBridge', async () => {
      const agent = createMockAgent({
        execute: async () => makeAgentResult({ content: 'deep analysis' }),
      });
      const gw = new IntelligenceGateway(createMockLightLlm(), agent);
      const result = await gw.handle(makeGatewayParams({ complexity: 'complex' }));

      expect(result.content).toBe('deep analysis');
    });

    test('无 agentParams 时抛出错误', async () => {
      const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());
      await expect(
        gw.handle(makeGatewayParams({ complexity: 'complex', agentParams: undefined })),
      ).rejects.toThrow('agentParams required');
    });
  });

  describe('安全阀', () => {
    test('LightLLM 回复包含降级短语时自动下沉到 Agent Layer', async () => {
      const lightLlm = createMockLightLlm('我需要更仔细地处理这个问题');
      const agent = createMockAgent({
        execute: async () => makeAgentResult({ content: 'agent handled it' }),
      });
      const gw = new IntelligenceGateway(lightLlm, agent);

      const result = await gw.handle(makeGatewayParams({ message: '今天天气怎么样' }));

      expect(result.content).toBe('agent handled it');
      expect(result.handledBy).toBe('claude');
    });

    test('LightLLM 回复包含降级短语但无 agentParams 时直接返回', async () => {
      const lightLlm = createMockLightLlm('我需要更仔细地处理这个问题');
      const gw = new IntelligenceGateway(lightLlm, createMockAgent());

      const result = await gw.handle(
        makeGatewayParams({ message: '今天天气怎么样', agentParams: undefined }),
      );

      // 无 agentParams 时安全阀不触发，直接返回 LightLLM 原始回复
      expect(result.content).toBe('我需要更仔细地处理这个问题');
      expect(result.handledBy).toBe('gateway');
    });
  });

  describe('返回结构完整性', () => {
    test('gateway 直接处理的返回应包含完整 AgentResult 字段', async () => {
      const gw = new IntelligenceGateway(createMockLightLlm('回复'), createMockAgent());
      const result = await gw.handle(makeGatewayParams({ message: '你好' }));

      // 验证所有必需字段存在且类型正确
      expect(typeof result.content).toBe('string');
      expect(typeof result.tokenUsage).toBe('object');
      expect(typeof result.tokenUsage.inputTokens).toBe('number');
      expect(typeof result.tokenUsage.outputTokens).toBe('number');
      expect(result.tokenUsage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.tokenUsage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(typeof result.finishedNaturally).toBe('boolean');
      expect(typeof result.handledBy).toBe('string');
    });

    test('英文安全阀短语也应该触发降级', async () => {
      const lightLlm = createMockLightLlm('I need to handle this more carefully');
      const agent = createMockAgent({
        execute: async () => makeAgentResult({ content: 'agent fallback' }),
      });
      const gw = new IntelligenceGateway(lightLlm, agent);

      const result = await gw.handle(makeGatewayParams({ message: 'hi' }));

      expect(result.content).toBe('agent fallback');
      expect(result.handledBy).toBe('claude');
    });

    test('agent 处理的返回应透传 AgentBridge 结果', async () => {
      const expectedResult = makeAgentResult({
        content: 'agent 结果',
        tokenUsage: { inputTokens: 200, outputTokens: 100 },
        handledBy: 'claude',
        toolsUsed: ['memory_search'],
      });
      const agent = createMockAgent({ execute: async () => expectedResult });
      const gw = new IntelligenceGateway(createMockLightLlm(), agent);

      const result = await gw.handle(makeGatewayParams({ complexity: 'complex' }));

      expect(result.content).toBe('agent 结果');
      expect(result.tokenUsage.inputTokens).toBe(200);
      expect(result.tokenUsage.outputTokens).toBe(100);
      expect(result.handledBy).toBe('claude');
      expect(result.toolsUsed).toEqual(['memory_search']);
    });
  });

  describe('mightNeedTools', () => {
    const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());

    test.each([
      ['帮我创建一个文件', true],
      ['请你分析一下这段代码', true],
      ['search for something', true],
      ['can you calculate this', true],
      ['能不能帮我查找一下', true],
      ['你好', false],
      ['1+1等于几', false],
      ['what is love', false],
    ])('"%s" → %s', (content, expected) => {
      expect(gw.mightNeedTools(content)).toBe(expected);
    });
  });

  describe('mightNeedMemory', () => {
    const gw = new IntelligenceGateway(createMockLightLlm(), createMockAgent());

    test.each([
      ['我们之前讨论过什么', true],
      ['上次你说了什么', true],
      ['do you remember what I said', true],
      ['as previously mentioned', true],
      ['你好', false],
      ['今天天气如何', false],
    ])('"%s" → %s', (content, expected) => {
      expect(gw.mightNeedMemory(content)).toBe(expected);
    });
  });
});
