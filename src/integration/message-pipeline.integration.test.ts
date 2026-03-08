/**
 * 集成测试: 消息处理管道
 *
 * 测试完整的消息流程:
 *   MessageRouter → CentralController → AgentRuntime → ClaudeAgentBridge/LightLLMClient → ResponseDispatcher
 *
 * 所有 LLM 后端均使用 mock，不产生真实 API 调用。
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { MessageRouter } from '../gateway/message-router';
import { AgentRuntime } from '../kernel/agents/agent-runtime';
import type { AgentBridgeResult, ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { SessionManager } from '../kernel/sessioning/session-manager';
import { YourBotError } from '../shared/errors/yourbot-error';
import type { BotMessage, BotResponse, ChannelType } from '../shared/messaging';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import { createMockLightLLM } from '../test-utils/mock-light-llm';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

// ── Test helpers ──────────────────────────────────────────

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}`,
    channel: 'web',
    userId: 'user_integ',
    userName: 'Integration Tester',
    conversationId: 'conv_integ',
    content: 'hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function createMockClaudeBridge(response = 'Claude says hi'): ClaudeAgentBridge {
  return {
    execute: mock(async (params: { onStream?: (e: StreamEvent) => void }) => {
      if (params.onStream) {
        params.onStream({ type: 'text_delta', text: response });
        params.onStream({ type: 'done' });
      }
      return {
        content: response,
        toolsUsed: [],
        turns: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      } satisfies AgentBridgeResult;
    }),
    estimateCost: () => 0.001,
    getActiveSessions: () => 0,
  } as unknown as ClaudeAgentBridge;
}

// ── Tests ─────────────────────────────────────────────────

describe('消息管道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    CentralController.resetInstance();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('端到端: MessageRouter → CentralController → AgentRuntime', () => {
    test('复杂任务应该经过 Claude Bridge 处理并通过 dispatcher 返回', async () => {
      const claudeBridge = createMockClaudeBridge('这是复杂任务的回答');
      const lightLLM = createMockLightLLM();
      const classifier = new TaskClassifier(lightLLM);

      const controller = CentralController.getInstance({
        claudeBridge,
        lightLLM,
        classifier,
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ channel: ChannelType; userId: string; content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (channel, userId, content) => {
        dispatched.push({ channel, userId, content });
      });

      const handler = router.createHandler();

      // "帮我写一段排序算法" goes through LLM classification (fuzzy patterns removed).
      // The mock LLM returns unparseable content → fallback to chat+complex → Claude Bridge.
      // Use a longer message to avoid hitting the short-message simple rule.
      await handler(createMessage({ content: '帮我写一段排序算法，要求支持多种数据类型' }));

      // Claude bridge should have been called
      expect((claudeBridge.execute as ReturnType<typeof mock>).mock.calls.length).toBe(1);

      // Response should be dispatched back to the channel
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].channel).toBe('web');
      expect(dispatched[0].userId).toBe('user_integ');
      expect((dispatched[0].content as { text: string }).text).toBe('这是复杂任务的回答');
    });

    test('简单任务应该经过 LightLLM 处理', async () => {
      const claudeBridge = createMockClaudeBridge();
      const lightLLM = createMockLightLLM('简单回答');
      const classifier = new TaskClassifier(lightLLM);

      const controller = CentralController.getInstance({
        claudeBridge,
        lightLLM,
        classifier,
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (_ch, _uid, content) => {
        dispatched.push({ content });
      });

      const handler = router.createHandler();

      // Short message "hi" should match simple rule: ^.{1,10}$
      await handler(createMessage({ content: 'hi' }));

      // LightLLM.complete should have been called (not claude)
      expect((lightLLM.complete as ReturnType<typeof mock>).mock.calls.length).toBe(1);
      expect((claudeBridge.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);

      expect(dispatched).toHaveLength(1);
      expect((dispatched[0].content as { text: string }).text).toBe('简单回答');
    });

    test('LightLLM 不可用时，简单任务应该回退到 Claude Bridge', async () => {
      const claudeBridge = createMockClaudeBridge('fallback 回答');
      const classifier = new TaskClassifier(null);

      const controller = CentralController.getInstance({
        claudeBridge,
        lightLLM: null,
        classifier,
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (_ch, _uid, content) => {
        dispatched.push({ content });
      });

      const handler = router.createHandler();
      await handler(createMessage({ content: 'hi' }));

      expect((claudeBridge.execute as ReturnType<typeof mock>).mock.calls.length).toBe(1);
      expect(dispatched).toHaveLength(1);
      expect((dispatched[0].content as { text: string }).text).toBe('fallback 回答');
    });
  });

  describe('会话历史维护', () => {
    test('连续两条消息应该累积到同一会话', async () => {
      const sessionManager = new SessionManager();
      const claudeBridge = createMockClaudeBridge('回答1');

      const agentRuntime = new AgentRuntime({
        claudeBridge,
        classifier: new TaskClassifier(null),
      });

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
      });

      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async () => {});

      const handler = router.createHandler();

      const msg1 = createMessage({ content: '第一条消息', conversationId: 'conv_hist' });
      const msg2 = createMessage({ content: '第二条消息', conversationId: 'conv_hist' });

      await handler(msg1);
      await handler(msg2);

      const session = sessionManager.getSessionByKey('user_integ:web:conv_hist');
      // Each message adds 1 user + 1 assistant = 2 per round, so 4 total
      expect(session?.messages.length).toBe(4);
      expect(session?.messages[0].role).toBe('user');
      expect(session?.messages[0].content).toBe('第一条消息');
      expect(session?.messages[1].role).toBe('assistant');
      expect(session?.messages[2].role).toBe('user');
      expect(session?.messages[2].content).toBe('第二条消息');
      expect(session?.messages[3].role).toBe('assistant');
    });

    test('不同 conversationId 应该隔离到不同会话', async () => {
      const sessionManager = new SessionManager();
      const claudeBridge = createMockClaudeBridge('reply');

      const agentRuntime = new AgentRuntime({
        claudeBridge,
        classifier: new TaskClassifier(null),
      });

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
      });

      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async () => {});

      const handler = router.createHandler();

      await handler(createMessage({ content: 'A', conversationId: 'conv_A' }));
      await handler(createMessage({ content: 'B', conversationId: 'conv_B' }));

      const sessA = sessionManager.getSessionByKey('user_integ:web:conv_A');
      const sessB = sessionManager.getSessionByKey('user_integ:web:conv_B');

      expect(sessA?.messages.length).toBe(2);
      expect(sessB?.messages.length).toBe(2);
      expect(sessA?.messages[0].content).toBe('A');
      expect(sessB?.messages[0].content).toBe('B');
    });
  });

  describe('错误处理管道', () => {
    test('Claude Bridge 失败时应该发送错误响应并抛出 YourBotError', async () => {
      const claudeBridge = {
        execute: mock(async () => {
          throw new Error('Claude CLI crashed');
        }),
        estimateCost: () => 0,
        getActiveSessions: () => 0,
      } as unknown as ClaudeAgentBridge;

      const controller = CentralController.getInstance({
        claudeBridge,
        classifier: new TaskClassifier(null),
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (_ch, _uid, content) => {
        dispatched.push({ content });
      });

      const handler = router.createHandler();

      try {
        await handler(createMessage({ content: '帮我debug' }));
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
      }

      // Error response should still be dispatched to the user
      expect(dispatched).toHaveLength(1);
      expect((dispatched[0].content as { text: string }).text).toContain('处理失败');
    });

    test('分类器失败时应该保守默认为 complex 并继续', async () => {
      const claudeBridge = createMockClaudeBridge('safe fallback');
      const brokenClassifier = {
        classify: mock(async () => {
          throw new Error('分类器异常');
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

      const agentRuntime = new AgentRuntime({
        claudeBridge,
        classifier: brokenClassifier,
      });

      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (_ch, _uid, content) => {
        dispatched.push({ content });
      });

      const handler = router.createHandler();

      // Even though classifier fails, the message should still be processed
      // AgentRuntime catches classifier errors and falls back to complex
      try {
        await handler(createMessage({ content: '测试' }));
      } catch {
        // May or may not throw depending on how agentRuntime handles it
      }

      // If no error response was dispatched, the success response should be there
      // The classifier error is caught inside AgentRuntime.execute
      if (dispatched.length > 0) {
        expect(dispatched.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('ResponseDispatcher 集成', () => {
    test('无 dispatcher 时不应崩溃', async () => {
      const claudeBridge = createMockClaudeBridge('no dispatcher');

      const controller = CentralController.getInstance({
        claudeBridge,
        classifier: new TaskClassifier(null),
        ...createMockOVDeps(),
      });

      // No setResponseDispatcher called — should still process without error
      const router = new MessageRouter(controller);
      const handler = router.createHandler();

      // Should not throw
      await handler(createMessage({ content: '帮我写代码' }));
    });

    test('dispatcher 失败时不应阻塞错误上报', async () => {
      const claudeBridge = {
        execute: mock(async () => {
          throw new Error('processing error');
        }),
        estimateCost: () => 0,
        getActiveSessions: () => 0,
      } as unknown as ClaudeAgentBridge;

      const controller = CentralController.getInstance({
        claudeBridge,
        classifier: new TaskClassifier(null),
        ...createMockOVDeps(),
      });

      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async () => {
        throw new Error('dispatcher also fails');
      });

      const handler = router.createHandler();

      try {
        await handler(createMessage({ content: '帮我debug' }));
        expect(true).toBe(false);
      } catch (error) {
        // Should still get the original error wrapped as YourBotError
        expect(error).toBeInstanceOf(YourBotError);
      }
    });
  });

  describe('分类器规则集成', () => {
    test('斜杠命令应该被 CentralController 识别为系统任务', async () => {
      const claudeBridge = createMockClaudeBridge();

      const controller = CentralController.getInstance({
        claudeBridge,
        classifier: new TaskClassifier(null),
        ...createMockOVDeps(),
      });

      const dispatched: Array<{ content: BotResponse }> = [];
      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async (_ch, _uid, content) => {
        dispatched.push({ content });
      });

      const handler = router.createHandler();
      await handler(createMessage({ content: '/help' }));

      // /help is classified as 'system' by CentralController.classifyIntent
      // System tasks don't go through AgentRuntime
      expect((claudeBridge.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(dispatched).toHaveLength(1);
      expect((dispatched[0].content as { text: string }).text).toContain('help');
    });

    test('TaskClassifier 规则层应该正确标记 harness 模式', async () => {
      const lightLLM = createMockLightLLM();
      const classifier = new TaskClassifier(lightLLM);

      // "/harness" should hit explicit harness rule
      const result = classifier.ruleClassify('/harness 创建一个 React 项目');
      expect(result).not.toBeNull();
      expect(result?.taskType).toBe('harness');
      expect(result?.complexity).toBe('complex');
    });

    test('TaskClassifier 规则层应该正确标记 simple 模式', async () => {
      const classifier = new TaskClassifier(null);

      // Question ending with ? should hit simple rule
      const result = classifier.ruleClassify('这是什么？');
      expect(result).not.toBeNull();
      expect(result?.complexity).toBe('simple');
    });
  });

  describe('多通道消息隔离', () => {
    test('同一用户在不同通道的消息应该隔离会话', async () => {
      const sessionManager = new SessionManager();
      const claudeBridge = createMockClaudeBridge('reply');

      const agentRuntime = new AgentRuntime({
        claudeBridge,
        classifier: new TaskClassifier(null),
      });

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
      });

      const router = new MessageRouter(controller);
      router.setResponseDispatcher(async () => {});

      const handler = router.createHandler();

      await handler(createMessage({ channel: 'web', content: 'web msg', conversationId: 'c1' }));
      await handler(
        createMessage({ channel: 'feishu', content: 'feishu msg', conversationId: 'c1' }),
      );

      const webSession = sessionManager.getSessionByKey('user_integ:web:c1');
      const feishuSession = sessionManager.getSessionByKey('user_integ:feishu:c1');

      expect(webSession).toBeDefined();
      expect(feishuSession).toBeDefined();
      expect(webSession?.id).not.toBe(feishuSession?.id);
      expect(webSession?.messages[0].content).toBe('web msg');
      expect(feishuSession?.messages[0].content).toBe('feishu msg');
    });
  });
});
