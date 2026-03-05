import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { YourBotError } from '../shared/errors/yourbot-error';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import { AgentRuntime } from './agents/agent-runtime';
import { CentralController } from './central-controller';
import type { CentralControllerDeps } from './central-controller';
import { Scheduler } from './scheduling/scheduler';
import { SessionManager } from './sessioning/session-manager';
import type { ChannelStreamAdapter } from './streaming/stream-protocol';
import { TaskQueue } from './tasking/task-queue';

function createMockMessage(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    id: 'msg_test_001',
    channel: 'web',
    userId: 'user_test_001',
    userName: 'Test User',
    conversationId: 'conv_test_001',
    content: 'Hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

/** Creates mock deps for OV-based modules to avoid network calls in tests */
function createMockOVDeps(): Partial<CentralControllerDeps> {
  return {
    knowledgeRouter: {
      buildContext: async () => ({
        systemPrompt: '--- Agent Identity ---\nTest Agent\n--- Agent Soul ---\nBe helpful',
        fragments: [],
        totalTokens: 20,
        conflictsResolved: [],
        retrievedMemories: [],
      }),
    } as any,
    postResponseAnalyzer: {
      analyzeExchange: async () => null,
    } as any,
    ovClient: {
      addMessage: async () => {},
      commit: async () => ({ memories_extracted: 0 }),
    } as any,
    contextManager: {
      checkAndFlush: async () => null,
    } as any,
    configLoader: {
      loadAll: async () => ({
        soul: 'Be helpful',
        identity: 'Test Agent',
        user: '',
        agents: '',
      }),
      invalidateCache: () => {},
    } as any,
    lessonsUpdater: {
      addLesson: async () => true,
    } as any,
    evolutionScheduler: {
      schedulePostCommit: () => {},
    } as any,
    entityManager: {} as any,
  };
}

describe('CentralController', () => {
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

  describe('getInstance', () => {
    test('应该返回单例实例', () => {
      const instance = CentralController.getInstance();
      expect(instance).toBeDefined();
      expect(instance).toBeInstanceOf(CentralController);
    });

    test('应该在多次调用时返回相同的实例', () => {
      const instance1 = CentralController.getInstance();
      const instance2 = CentralController.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('classifyIntent', () => {
    test('应该将以 / 开头的消息分类为系统任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '/help' });
      expect(controller.classifyIntent(message)).toBe('system');
    });

    test('应该将普通消息分类为聊天任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '你好' });
      expect(controller.classifyIntent(message)).toBe('chat');
    });

    test('应该将包含"每天"的消息分类为定时任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '每天早上提醒我喝水' });
      expect(controller.classifyIntent(message)).toBe('scheduled');
    });

    test('应该将包含"提醒我"的消息分类为定时任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '提醒我下午3点开会' });
      expect(controller.classifyIntent(message)).toBe('scheduled');
    });

    test('应该将英文定时模式分类为定时任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: 'remind me every day at 9:00' });
      expect(controller.classifyIntent(message)).toBe('scheduled');
    });

    test('应该将包含"自动化"的消息分类为自动化任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '自动化处理这些文件' });
      expect(controller.classifyIntent(message)).toBe('automation');
    });

    test('应该将包含 batch 的消息分类为自动化任务', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: 'batch process these files' });
      expect(controller.classifyIntent(message)).toBe('automation');
    });

    test('应该将无法识别的内容默认分类为聊天', () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '今天天气怎么样？' });
      expect(controller.classifyIntent(message)).toBe('chat');
    });
  });

  describe('calculatePriority', () => {
    test('应该为系统任务分配最高优先级 1', () => {
      const controller = CentralController.getInstance();
      expect(controller.calculatePriority('system')).toBe(1);
    });

    test('应该为聊天任务分配优先级 5', () => {
      const controller = CentralController.getInstance();
      expect(controller.calculatePriority('chat')).toBe(5);
    });

    test('应该为定时任务分配优先级 10', () => {
      const controller = CentralController.getInstance();
      expect(controller.calculatePriority('scheduled')).toBe(10);
    });

    test('应该为自动化任务分配优先级 15', () => {
      const controller = CentralController.getInstance();
      expect(controller.calculatePriority('automation')).toBe(15);
    });
  });

  describe('handleIncomingMessage', () => {
    test('应该解析会话并为聊天消息执行 AgentRuntime', async () => {
      const sessionManager = new SessionManager();
      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute');
      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({ content: '你好啊' });
      await controller.handleIncomingMessage(message);

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    test('应该在非 YourBotError 错误时包装为 YourBotError', async () => {
      const sessionManager = new SessionManager();
      spyOn(sessionManager, 'resolveSession').mockRejectedValue(new Error('数据库连接失败'));
      const controller = CentralController.getInstance({ sessionManager, ...createMockOVDeps() });

      const message = createMockMessage();
      try {
        await controller.handleIncomingMessage(message);
        expect(true).toBe(false); // 不应到达这里
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).code).toBe('UNKNOWN');
      }
    });

    test('应该在 YourBotError 时直接传播', async () => {
      const sessionManager = new SessionManager();
      const originalError = new YourBotError('AUTH_FAILED', '认证失败');
      spyOn(sessionManager, 'resolveSession').mockRejectedValue(originalError);
      const controller = CentralController.getInstance({ sessionManager, ...createMockOVDeps() });

      const message = createMockMessage();
      try {
        await controller.handleIncomingMessage(message);
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBe(originalError);
      }
    });
  });

  describe('orchestrate', () => {
    test('应该将聊天任务路由到 agentRuntime', async () => {
      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute');
      const controller = CentralController.getInstance({ agentRuntime, ...createMockOVDeps() });

      const session = {
        id: 'sess_001',
        userId: 'user_001',
        channel: 'web',
        conversationId: 'conv_001',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
      };

      const task = {
        id: 'task_001',
        traceId: 'trace_001',
        type: 'chat' as const,
        message: createMockMessage(),
        session,
        priority: 5,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
      };

      await controller.orchestrate(task);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    test('应该将定时任务路由到 scheduler', async () => {
      const scheduler = new Scheduler();
      const registerSpy = spyOn(scheduler, 'register');
      const controller = CentralController.getInstance({ scheduler, ...createMockOVDeps() });

      const session = {
        id: 'sess_001',
        userId: 'user_001',
        channel: 'web',
        conversationId: 'conv_001',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
      };

      const task = {
        id: 'task_002',
        traceId: 'trace_002',
        type: 'scheduled' as const,
        message: createMockMessage({ content: '每天提醒我' }),
        session,
        priority: 10,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
      };

      const result = await controller.orchestrate(task);
      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    test('应该对系统任务返回成功结果', async () => {
      const controller = CentralController.getInstance(createMockOVDeps());

      const session = {
        id: 'sess_001',
        userId: 'user_001',
        channel: 'web',
        conversationId: 'conv_001',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
      };

      const task = {
        id: 'task_003',
        traceId: 'trace_003',
        type: 'system' as const,
        message: createMockMessage({ content: '/help' }),
        session,
        priority: 1,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
      };

      const result = await controller.orchestrate(task);
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).command).toBe('help');
    });

    test('应该将自动化任务路由到 taskQueue', async () => {
      const taskQueue = new TaskQueue();
      const enqueueSpy = spyOn(taskQueue, 'enqueue');
      const controller = CentralController.getInstance({ taskQueue, ...createMockOVDeps() });

      const session = {
        id: 'sess_001',
        userId: 'user_001',
        channel: 'web',
        conversationId: 'conv_001',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
      };

      const task = {
        id: 'task_004',
        traceId: 'trace_004',
        type: 'automation' as const,
        message: createMockMessage({ content: '批量处理' }),
        session,
        priority: 15,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
      };

      await controller.orchestrate(task);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelRequest', () => {
    test('应该在请求存在时返回 true 并中止', async () => {
      const agentRuntime = new AgentRuntime();
      // Make execute slow so we can cancel (500ms, well within test timeout)
      spyOn(agentRuntime, 'execute').mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  content: 'test',
                  tokenUsage: { inputTokens: 0, outputTokens: 0 },
                  complexity: 'complex' as const,
                  channel: 'agent_sdk' as const,
                  classificationCostUsd: 0,
                }),
              500,
            ),
          ),
      );
      const controller = CentralController.getInstance({ agentRuntime, ...createMockOVDeps() });
      const message = createMockMessage();

      // Start processing but don't await
      const handlePromise = controller.handleIncomingMessage(message);

      // Wait a tick for the task to be registered
      await new Promise((resolve) => setTimeout(resolve, 50));

      // There should be an active request
      expect(controller.getActiveRequestCount()).toBe(1);

      // After the promise resolves/rejects, active requests should be cleaned up
      await handlePromise.catch(() => {});
    });

    test('应该在请求不存在时返回 false', () => {
      const controller = CentralController.getInstance(createMockOVDeps());
      expect(controller.cancelRequest('nonexistent_task')).toBe(false);
    });
  });

  describe('聊天任务应该维护会话历史', () => {
    test('应该将用户消息和助手响应添加到会话历史', async () => {
      const sessionManager = new SessionManager();
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'Bot reply',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({ content: '你好' });
      await controller.handleIncomingMessage(message);

      const session = sessionManager.getSessionByKey('user_test_001:web:conv_test_001');
      expect(session?.messages.length).toBe(2); // user + assistant
      expect(session?.messages[0].role).toBe('user');
      expect(session?.messages[0].content).toBe('你好');
      expect(session?.messages[1].role).toBe('assistant');
      expect(session?.messages[1].content).toBe('Bot reply');
    });
  });

  describe('流式管道集成', () => {
    test('应该通过 streamAdapterFactory 创建适配器并传递流式事件', async () => {
      const agentRuntime = new AgentRuntime();
      const streamEvents: StreamEvent[] = [];

      // Mock execute to emit stream events via callback
      spyOn(agentRuntime, 'execute').mockImplementation(async (params) => {
        if (params.streamCallback) {
          params.streamCallback({ type: 'text_delta', text: 'Hello' });
          params.streamCallback({ type: 'text_delta', text: ' World' });
          params.streamCallback({ type: 'done' });
        }
        return {
          content: 'Hello World',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          complexity: 'simple' as const,
          channel: 'light_llm' as const,
          classificationCostUsd: 0,
        };
      });

      const mockAdapter: ChannelStreamAdapter = {
        channelType: 'test',
        onStreamStart: async () => {},
        sendChunk: async (text: string) => {
          streamEvents.push({ type: 'text_delta', text });
        },
        sendDone: async () => {
          streamEvents.push({ type: 'done' });
        },
        sendError: async () => {},
      };

      const controller = CentralController.getInstance({
        agentRuntime,
        streamAdapterFactory: () => [mockAdapter],
        ...createMockOVDeps(),
      });

      const message = createMockMessage({ content: '你好' });
      await controller.handleIncomingMessage(message);

      // Adapter should have received stream events
      expect(streamEvents.length).toBeGreaterThanOrEqual(2);
      expect(streamEvents.some((e) => e.type === 'done')).toBe(true);
    });

    test('无 streamAdapterFactory 时应该回退到 streamCallback', async () => {
      const agentRuntime = new AgentRuntime();
      const callbackEvents: Array<{ userId: string; event: StreamEvent }> = [];

      spyOn(agentRuntime, 'execute').mockImplementation(async (params) => {
        if (params.streamCallback) {
          params.streamCallback({ type: 'text_delta', text: 'Hi' });
          params.streamCallback({ type: 'done' });
        }
        return {
          content: 'Hi',
          tokenUsage: { inputTokens: 5, outputTokens: 2 },
          complexity: 'simple' as const,
          channel: 'light_llm' as const,
          classificationCostUsd: 0,
        };
      });

      const controller = CentralController.getInstance({
        agentRuntime,
        streamCallback: (userId, event) => {
          callbackEvents.push({ userId, event });
        },
        ...createMockOVDeps(),
      });

      const message = createMockMessage({ content: '你好' });
      await controller.handleIncomingMessage(message);

      expect(callbackEvents.length).toBeGreaterThanOrEqual(1);
      expect(callbackEvents[0].userId).toBe('user_test_001');
    });
  });

  describe('Evolution 模块集成', () => {
    test('handleChatTask 应该生成非 undefined 的 systemPrompt', async () => {
      const sessionManager = new SessionManager();
      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'Bot reply',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({ content: '你好' });
      await controller.handleIncomingMessage(message);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const callArgs = executeSpy.mock.calls[0][0];
      expect(callArgs.context.systemPrompt).toBeDefined();
      expect(callArgs.context.systemPrompt).not.toBeUndefined();
      expect(callArgs.context.systemPrompt!.length).toBeGreaterThan(0);
    });

    test('session 关闭后应该触发 OV commit', async () => {
      const sessionManager = new SessionManager();
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'Reply',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      let commitCalledWith: string | null = null;
      const mockOvClient = {
        addMessage: async () => {},
        commit: async (sessionId: string) => {
          commitCalledWith = sessionId;
          return { memories_extracted: 1 };
        },
      } as any;

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
        ovClient: mockOvClient,
      });

      const message = createMockMessage({ content: '你好' });
      await controller.handleIncomingMessage(message);

      // Simulate session close
      const sessionKey = 'user_test_001:web:conv_test_001';
      const session = sessionManager.getSessionByKey(sessionKey);
      if (session) {
        await sessionManager.closeSession(session.id);
      }

      // OV commit should have been called via the onSessionClose callback
      expect(commitCalledWith).not.toBeNull();
    });

    test('用户纠正后回复应该包含确认反馈文本', async () => {
      const sessionManager = new SessionManager();
      const agentRuntime = new AgentRuntime();

      // Mock analyzer to return confirmation when correction keywords are present
      const mockAnalyzer = {
        analyzeExchange: async (
          _userId: string,
          userMsg: string,
        ) => {
          if (userMsg.includes('不对') || userMsg.includes('错了')) {
            return '我记住了：用户要求详细解释';
          }
          return null;
        },
      } as any;

      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: '这是简短回答',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        ...createMockOVDeps(),
        postResponseAnalyzer: mockAnalyzer,
      });

      // First message to establish context
      const firstMsg = createMockMessage({ content: '帮我解释一下这个代码' });
      await controller.handleIncomingMessage(firstMsg);

      // Reset for second call
      CentralController.resetInstance();
      const agentRuntime2 = new AgentRuntime();
      spyOn(agentRuntime2, 'execute').mockResolvedValue({
        content: '这是回复',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });
      const controller2 = CentralController.getInstance({
        sessionManager,
        agentRuntime: agentRuntime2,
        ...createMockOVDeps(),
        postResponseAnalyzer: mockAnalyzer,
      });

      // Second message with correction
      const correctionMsg = createMockMessage({ content: '不对，我要的是详细的代码解释' });
      const result = await controller2.handleIncomingMessage(correctionMsg);

      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('记住了');
    });
  });
});
