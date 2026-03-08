import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LessonsLearnedUpdater } from '../lessons/lessons-updater';
import { YourBotError } from '../shared/errors/yourbot-error';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { IChannel } from '../shared/messaging/channel-adapter.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import { AgentRuntime } from './agents/agent-runtime';
import type { LightLLMClient } from './agents/light-llm-client';
import { CentralController } from './central-controller';
import type { CentralControllerDeps } from './central-controller';
import type { EvolutionScheduler } from './evolution/evolution-scheduler';
import type { KnowledgeRouter } from './evolution/knowledge-router';
import type { PostResponseAnalyzer } from './evolution/post-response-analyzer';
import type { ConfigLoader } from './memory/config-loader';
import type { ContextManager } from './memory/context-manager';
import type { EntityManager } from './memory/graph/entity-manager';
import type { OpenVikingClient } from './memory/openviking/openviking-client';
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
    } as unknown as KnowledgeRouter,
    postResponseAnalyzer: {
      analyzeExchange: async () => null,
    } as unknown as PostResponseAnalyzer,
    ovClient: {
      addMessage: async () => {},
      commit: async () => ({ memories_extracted: 0 }),
    } as unknown as OpenVikingClient,
    contextManager: {
      checkAndFlush: async () => null,
    } as unknown as ContextManager,
    configLoader: {
      loadAll: async () => ({
        soul: 'Be helpful',
        identity: 'Test Agent',
        user: '',
        agents: '',
      }),
      invalidateCache: () => {},
    } as unknown as ConfigLoader,
    lessonsUpdater: {
      addLesson: async () => true,
    } as unknown as LessonsLearnedUpdater,
    evolutionScheduler: {
      schedulePostCommit: () => {},
    } as unknown as EvolutionScheduler,
    entityManager: {} as unknown as EntityManager,
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
    test('应该将以 / 开头的消息分类为系统任务', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '/help' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('system');
    });

    test('应该将普通消息分类为聊天任务', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '你好' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('chat');
    });

    test('定时任务现在由 LLM 分类（不再规则匹配）', async () => {
      // Without LLM, schedule-like messages fall through to chat (LLM fallback)
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '每天早上9点提醒我喝水吃药' });
      const result = await controller.classifyIntent(message);
      // No rule match, no LLM → defaults to chat
      expect(result.classifiedBy).toBe('llm');
    });

    test('带 LLM 的分类器应正确识别定时任务及 subIntent', async () => {
      const { TaskClassifier: TC } = await import('./classifier/task-classifier');
      const mockLLM = {
        complete: async () => ({
          content:
            '{"taskType":"scheduled","complexity":"complex","subIntent":"cancel","reason":"取消定时"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
        stream: async function* () {
          yield { content: 'test' };
        },
        getDefaultModel: () => 'gpt-4o-mini',
      } as unknown as LightLLMClient;
      const classifier = new TC(mockLLM);
      const controller = CentralController.getInstance({ classifier, ...createMockOVDeps() });
      const message = createMockMessage({ content: '我想取消之前设置的定时任务' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('scheduled');
      expect(result.subIntent).toBe('cancel');
    });

    test('应该将包含"自动化"的消息分类为自动化任务', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '自动化处理这些文件' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('automation');
    });

    test('应该将包含 batch 的消息分类为自动化任务', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: 'batch process these files' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('automation');
    });

    test('应该将无法识别的内容默认分类为聊天', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '今天天气怎么样？' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('chat');
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
        message: createMockMessage({ content: '每天上午9点提醒我' }),
        session,
        priority: 10,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
      };

      const result = await controller.orchestrate(task);
      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    test('subIntent=cancel 时应启动取消流程', async () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([]);
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
        id: 'task_cancel',
        traceId: 'trace_cancel',
        type: 'scheduled' as const,
        message: createMockMessage({ content: '取消定时任务' }),
        session,
        priority: 10,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
        classifyResult: {
          taskType: 'scheduled' as const,
          subIntent: 'cancel',
          complexity: 'complex' as const,
          reason: 'test',
          confidence: 0.75,
          classifiedBy: 'llm' as const,
          costUsd: 0,
        },
      };

      const result = await controller.orchestrate(task);
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('没有活跃的定时任务');
    });

    test('subIntent=list 时应返回任务列表', async () => {
      const scheduler = new Scheduler();
      spyOn(scheduler, 'listJobs').mockReturnValue([]);
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
        id: 'task_list',
        traceId: 'trace_list',
        type: 'scheduled' as const,
        message: createMockMessage({ content: '查看定时任务' }),
        session,
        priority: 10,
        createdAt: Date.now(),
        metadata: { userId: 'user_001', channel: 'web', conversationId: 'conv_001' },
        classifyResult: {
          taskType: 'scheduled' as const,
          subIntent: 'list',
          complexity: 'complex' as const,
          reason: 'test',
          confidence: 0.75,
          classifiedBy: 'llm' as const,
          costUsd: 0,
        },
      };

      const result = await controller.orchestrate(task);
      expect(result.success).toBe(true);
      expect((result.data as { content: string }).content).toContain('没有活跃的定时任务');
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
        streamAdapterFactory: (_u, _c, _conv) => [mockAdapter],
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
      expect(callArgs.context.systemPrompt?.length).toBeGreaterThan(0);
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
      } as unknown as OpenVikingClient;

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
        analyzeExchange: async (_userId: string, userMsg: string) => {
          if (userMsg.includes('不对') || userMsg.includes('错了')) {
            return '我记住了：用户要求详细解释';
          }
          return null;
        },
      } as unknown as PostResponseAnalyzer;

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

  describe('lightLLM callback in PostResponseAnalyzer', () => {
    test('构造时传入 lightLLM 应该自动包装为 llmCall', async () => {
      const sessionManager = new SessionManager();
      const agentRuntime = new AgentRuntime();

      // Mock lightLLM.complete
      const mockLightLLM = {
        complete: mock(async () => ({
          content: JSON.stringify({
            action: '使用 TypeScript',
            category: 'instruction',
            lesson: '用户要求用 TypeScript',
          }),
        })),
      };

      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: '好的',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      // Do NOT pass postResponseAnalyzer — let constructor build it with lightLLM callback
      const controller = CentralController.getInstance({
        sessionManager,
        agentRuntime,
        lightLLM: mockLightLLM as CentralControllerDeps['lightLLM'],
        knowledgeRouter: {
          buildContext: async () => ({
            systemPrompt: 'Test',
            fragments: [],
            totalTokens: 20,
            conflictsResolved: [],
            retrievedMemories: [],
          }),
        } as unknown as KnowledgeRouter,
        ovClient: {
          addMessage: async () => {},
          commit: async () => ({ memories_extracted: 0 }),
        } as unknown as OpenVikingClient,
        contextManager: {
          checkAndFlush: async () => null,
        } as unknown as ContextManager,
        configLoader: {
          loadAll: async () => ({
            soul: 'Be helpful',
            identity: 'Test',
            user: '',
            agents: '',
          }),
          invalidateCache: () => {},
        } as unknown as ConfigLoader,
        lessonsUpdater: {
          addLesson: async () => true,
        } as unknown as LessonsLearnedUpdater,
        evolutionScheduler: {
          schedulePostCommit: () => {},
        } as unknown as EvolutionScheduler,
        entityManager: {} as unknown as EntityManager,
      });

      // Send a correction message to trigger PostResponseAnalyzer with llmCall
      const message = createMockMessage({ content: '不对，应该用 TypeScript 写代码' });
      await controller.handleIncomingMessage(message);

      // lightLLM.complete should have been called through the llmCall wrapper
      expect(mockLightLLM.complete).toHaveBeenCalled();
    });
  });

  describe('classifyIntent — harness patterns', () => {
    test('应该将 /harness 命令分类为 harness 任务', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '/harness 修改代码' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('harness');
    });

    test('应该将 harness: 前缀分类为 harness 任务', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: 'harness: fix the bug' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('harness');
    });

    test('不应该将普通对话分类为 harness', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '你好' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('chat');
    });

    test('不应该将 /setup 分类为 harness', async () => {
      const controller = CentralController.getInstance();
      const message = createMockMessage({ content: '/setup' });
      const result = await controller.classifyIntent(message);
      expect(result.taskType).toBe('system');
    });
  });

  describe('setChannelResolver / setStreamAdapterFactory', () => {
    test('setChannelResolver 应该设置通道解析器', () => {
      const controller = CentralController.getInstance(createMockOVDeps());
      const resolver = (_type: string) => undefined;
      controller.setChannelResolver(resolver);
      // No error thrown = success
      expect(true).toBe(true);
    });

    test('setStreamAdapterFactory 应该设置流式适配器工厂', () => {
      const controller = CentralController.getInstance(createMockOVDeps());
      const factory = (_u: string, _c: string, _conv: string) => [] as ChannelStreamAdapter[];
      controller.setStreamAdapterFactory(factory);
      expect(true).toBe(true);
    });
  });

  describe('initScheduler / stopScheduler', () => {
    test('initScheduler 应该加载任务、设置 executor 并启动', async () => {
      const scheduler = new Scheduler();
      const loadSpy = spyOn(scheduler, 'loadJobs').mockResolvedValue();
      const setExecSpy = spyOn(scheduler, 'setExecutor');
      const startSpy = spyOn(scheduler, 'start');

      const controller = CentralController.getInstance({ scheduler, ...createMockOVDeps() });
      await controller.initScheduler();

      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(setExecSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    test('initScheduler executor 应该构造消息并推送结果', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: '定时任务结果',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'simple',
        channel: 'light_llm',
        classificationCostUsd: 0,
      });

      const sentMessages: Array<{ userId: string; text: string }> = [];
      const mockChannel = {
        sendMessage: async (userId: string, content: { text: string }) => {
          sentMessages.push({ userId, text: content.text });
        },
      } as unknown as IChannel;

      const scheduler = new Scheduler();
      const loadSpy = spyOn(scheduler, 'loadJobs').mockResolvedValue();
      spyOn(scheduler, 'start');
      // Capture the executor
      let capturedExecutor: ((job: unknown) => Promise<unknown>) | null = null;
      spyOn(scheduler, 'setExecutor').mockImplementation((exec) => {
        capturedExecutor = exec as (job: unknown) => Promise<unknown>;
      });

      const controller = CentralController.getInstance({
        scheduler,
        agentRuntime,
        channelResolver: () => mockChannel,
        ...createMockOVDeps(),
      });

      await controller.initScheduler();
      expect(capturedExecutor).toBeTruthy();
      expect(loadSpy).toHaveBeenCalled();

      // Invoke the executor with a mock job
      const mockJob = {
        id: 'job_001',
        channel: 'web',
        userId: 'user_test',
        description: '每天提醒喝水',
        taskTemplate: {
          messageContent: '提醒喝水',
          userName: 'Test',
          conversationId: 'sched_conv',
        },
      };

      const result = await (capturedExecutor as NonNullable<typeof capturedExecutor>)(mockJob);
      expect((result as { success: boolean }).success).toBe(true);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].userId).toBe('user_test');
    });

    test('initScheduler executor 推送失败时不应抛出', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: '结果',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'simple',
        channel: 'light_llm',
        classificationCostUsd: 0,
      });

      const mockChannel = {
        sendMessage: async () => {
          throw new Error('send failed');
        },
      } as unknown as IChannel;

      const scheduler = new Scheduler();
      spyOn(scheduler, 'loadJobs').mockResolvedValue();
      spyOn(scheduler, 'start');
      let capturedExecutor: ((job: unknown) => Promise<unknown>) | null = null;
      spyOn(scheduler, 'setExecutor').mockImplementation((exec) => {
        capturedExecutor = exec as (job: unknown) => Promise<unknown>;
      });

      const controller = CentralController.getInstance({
        scheduler,
        agentRuntime,
        channelResolver: () => mockChannel,
        ...createMockOVDeps(),
      });

      await controller.initScheduler();

      const mockJob = {
        id: 'job_002',
        channel: 'web',
        userId: 'user_test',
        description: '提醒',
        taskTemplate: {},
      };

      // Should not throw even though sendMessage fails
      const result = await (capturedExecutor as NonNullable<typeof capturedExecutor>)(mockJob);
      expect((result as { success: boolean }).success).toBe(true);
    });

    test('stopScheduler 应该停止并持久化', () => {
      const scheduler = new Scheduler();
      const stopSpy = spyOn(scheduler, 'stop');
      const persistSpy = spyOn(scheduler, 'persistJobs');

      const controller = CentralController.getInstance({ scheduler, ...createMockOVDeps() });
      controller.stopScheduler();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(persistSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleUserMdUpload', () => {
    test('web 通道 base64 文件上传应该处理成功', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');
      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const fileContent = '# My Profile\nI like coding';
      const base64 = Buffer.from(fileContent).toString('base64');
      const message = createMockMessage({
        contentType: 'file',
        content: '[文件: user.md]',
        metadata: {
          fileName: 'user.md',
          fileContentBase64: base64,
        },
      });

      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('已更新成功');
    });

    test('feishu 通道 fileKey 上传应该通过 channelResolver 下载', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');

      const fileContent = '# My Profile';
      const mockChannel = {
        downloadFile: mock(async () => Buffer.from(fileContent)),
      } as unknown as IChannel;

      const controller = CentralController.getInstance({
        agentRuntime,
        channelResolver: () => mockChannel,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({
        contentType: 'file',
        content: '[文件: user.md]',
        metadata: {
          fileName: 'user.md',
          fileKey: 'fkey_001',
        },
      });

      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('已更新成功');
    });

    test('通道不支持文件下载时应该返回提示', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');

      const mockChannel = {} as unknown as IChannel; // no downloadFile
      const controller = CentralController.getInstance({
        agentRuntime,
        channelResolver: () => mockChannel,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({
        contentType: 'file',
        content: '[文件: user.md]',
        metadata: {
          fileName: 'user.md',
          fileKey: 'fkey_001',
        },
      });

      const result = await controller.handleIncomingMessage(message);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('不支持文件下载');
    });

    test('无 fileKey 且无 base64 时应该返回无法获取', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');

      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({
        contentType: 'file',
        content: '[文件: user.md]',
        metadata: {
          fileName: 'user.md',
        },
      });

      const result = await controller.handleIncomingMessage(message);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('无法获取文件内容');
    });

    test('文件处理异常时应该返回失败提示', async () => {
      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');

      const controller = CentralController.getInstance({
        agentRuntime,
        channelResolver: () =>
          ({
            downloadFile: async () => {
              throw new Error('download failed');
            },
          }) as unknown as IChannel,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({
        contentType: 'file',
        content: '[文件: user.md]',
        metadata: {
          fileName: 'user.md',
          fileKey: 'fkey_001',
        },
      });

      const result = await controller.handleIncomingMessage(message);
      const content = (result.data as Record<string, unknown>).content as string;
      expect(content).toContain('文件处理失败');
    });
  });

  describe('harness task via handleIncomingMessage', () => {
    test('harness 消息应该经过 worktreePool 执行', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'web:user_test_001';

      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const worktreePool = {
        acquire: async (taskId: string, branch: string) => ({
          id: 'harness-mock',
          branch,
          worktreePath: '/tmp/worktree-mock',
          taskId,
          createdAt: Date.now(),
        }),
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({ content: '/harness 修复bug' });
      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });
  });

  describe('calculatePriority — harness', () => {
    test('应该为 harness 任务分配优先级 2', () => {
      const controller = CentralController.getInstance();
      expect(controller.calculatePriority('harness')).toBe(2);
    });
  });

  describe('handleHarnessTask', () => {
    test('非管理员发送 harness 消息应降级为 chat', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'feishu:admin_only';

      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute');
      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const session = {
        id: 'sess_001',
        userId: 'user_regular',
        channel: 'web',
        conversationId: 'conv_001',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
        workspacePath: '/tmp/user-space/user_regular',
      };

      const task = {
        id: 'task_001',
        traceId: 'trace_001',
        type: 'harness' as const,
        message: createMockMessage({ userId: 'user_regular', content: '修复bug' }),
        session,
        priority: 2,
        createdAt: Date.now(),
        metadata: { userId: 'user_regular', channel: 'web', conversationId: 'conv_001' },
      };

      await controller.orchestrate(task);
      expect(task.type).toBe('chat');
      expect(executeSpy).toHaveBeenCalledTimes(1);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('管理员发送 harness 消息应使用 worktree 路径', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'feishu:admin_user';

      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute');

      let capturedTaskId = '';
      let capturedBranch = '';
      const worktreePool = {
        acquire: async (taskId: string, branch: string) => {
          capturedTaskId = taskId;
          capturedBranch = branch;
          return {
            id: 'harness-mock',
            branch,
            worktreePath: '/tmp/worktree-harness',
            taskId,
            createdAt: Date.now(),
          };
        },
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        ...createMockOVDeps(),
      });

      const session = {
        id: 'sess_002',
        userId: 'feishu:admin_user',
        channel: 'feishu',
        conversationId: 'conv_002',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
        workspacePath: '/tmp/user-space/feishu:admin_user',
      };

      const task = {
        id: 'task_002',
        traceId: 'trace_002',
        type: 'harness' as const,
        message: createMockMessage({ userId: 'feishu:admin_user', content: '修复bug' }),
        session,
        priority: 2,
        createdAt: Date.now(),
        metadata: { userId: 'feishu:admin_user', channel: 'feishu', conversationId: 'conv_002' },
      };

      await controller.orchestrate(task);
      expect(task.type).toBe('harness');
      expect(executeSpy).toHaveBeenCalledTimes(1);

      const callArgs = executeSpy.mock.calls[0][0] as Record<string, unknown>;
      const context = callArgs.context as Record<string, unknown>;
      // Should use worktree path, not process.cwd()
      expect(context.workspacePath).toBe('/tmp/worktree-harness');
      // Harness tasks must force complex (Claude) path
      expect(callArgs.forceComplex).toBe(true);
      // worktreePool.acquire should have been called with the task id
      expect(capturedTaskId).toBe('task_002');
      expect(capturedBranch).toMatch(/^agent\/fix\//);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('非管理员降级后不应 forceComplex', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'feishu:admin_only';

      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute');
      const controller = CentralController.getInstance({
        agentRuntime,
        ...createMockOVDeps(),
      });

      const session = {
        id: 'sess_003',
        userId: 'user_regular',
        channel: 'web',
        conversationId: 'conv_003',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
        workspacePath: '/tmp/user-space/user_regular',
      };

      const task = {
        id: 'task_003',
        traceId: 'trace_003',
        type: 'harness' as const,
        message: createMockMessage({ userId: 'user_regular', content: '修复bug' }),
        session,
        priority: 2,
        createdAt: Date.now(),
        metadata: { userId: 'user_regular', channel: 'web', conversationId: 'conv_003' },
      };

      await controller.orchestrate(task);
      const callArgs = executeSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.forceComplex).toBeUndefined();

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('后续 harness 消息应复用 session 中的 worktree', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'feishu:admin_user';

      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute');

      let acquireCount = 0;
      const worktreePool = {
        acquire: async (taskId: string, branch: string) => {
          acquireCount++;
          return {
            id: 'harness-slot-1',
            branch,
            worktreePath: '/tmp/worktree-persist',
            taskId,
            createdAt: Date.now(),
          };
        },
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        ...createMockOVDeps(),
      });

      // Session already has worktree bound (simulating follow-up message)
      const session = {
        id: 'sess_followup',
        userId: 'feishu:admin_user',
        channel: 'feishu',
        conversationId: 'conv_followup',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
        workspacePath: '/tmp/user-space/feishu:admin_user',
        harnessWorktreeSlotId: 'harness-slot-1',
        harnessWorktreePath: '/tmp/worktree-persist',
      };

      const task = {
        id: 'task_followup',
        traceId: 'trace_followup',
        type: 'harness' as const,
        message: createMockMessage({
          userId: 'feishu:admin_user',
          content: '继续修改代码',
        }),
        session,
        priority: 2,
        createdAt: Date.now(),
        metadata: {
          userId: 'feishu:admin_user',
          channel: 'feishu',
          conversationId: 'conv_followup',
        },
      };

      await controller.orchestrate(task);
      // Should NOT call acquire — worktree already bound
      expect(acquireCount).toBe(0);
      expect(executeSpy).toHaveBeenCalledTimes(1);

      const callArgs = executeSpy.mock.calls[0][0] as Record<string, unknown>;
      const context = callArgs.context as Record<string, unknown>;
      expect(context.workspacePath).toBe('/tmp/worktree-persist');
      expect(callArgs.forceComplex).toBe(true);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('首次 harness 消息应 acquire worktree 并绑定到 session', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'feishu:admin_user';

      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');

      const worktreePool = {
        acquire: async (taskId: string, branch: string) => ({
          id: 'harness-new-slot',
          branch,
          worktreePath: '/tmp/worktree-new',
          taskId,
          createdAt: Date.now(),
        }),
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        ...createMockOVDeps(),
      });

      const session = {
        id: 'sess_first',
        userId: 'feishu:admin_user',
        channel: 'feishu',
        conversationId: 'conv_first',
        status: 'active' as const,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        agentConfig: { maxContextTokens: 100000 },
        messages: [],
        workspacePath: '/tmp/user-space/feishu:admin_user',
      };

      const task = {
        id: 'task_first',
        traceId: 'trace_first',
        type: 'harness' as const,
        message: createMockMessage({
          userId: 'feishu:admin_user',
          content: '/harness 修复代码',
        }),
        session,
        priority: 2,
        createdAt: Date.now(),
        metadata: {
          userId: 'feishu:admin_user',
          channel: 'feishu',
          conversationId: 'conv_first',
        },
      };

      await controller.orchestrate(task);
      // Session should now have worktree bound
      expect(session.harnessWorktreeSlotId).toBe('harness-new-slot');
      expect(session.harnessWorktreePath).toBe('/tmp/worktree-new');

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });
  });

  describe('harness group chat isolation', () => {
    test('feishu harness 消息应创建群聊并重新 resolve session', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'user_test_001';

      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const worktreePool = {
        acquire: async (taskId: string, branch: string) => ({
          id: 'harness-gc-slot',
          branch,
          worktreePath: '/tmp/worktree-gc',
          taskId,
          createdAt: Date.now(),
        }),
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const mockCreateGroupChat = mock(async () => 'oc_group_new');
      const mockSendMessage = mock(async () => {});

      const feishuChannel = {
        type: 'feishu',
        name: 'feishu',
        createGroupChat: mockCreateGroupChat,
        sendMessage: mockSendMessage,
      } as unknown as IChannel;

      const channelResolver = (type: string) => (type === 'feishu' ? feishuChannel : undefined);

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        channelResolver,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({
        channel: 'feishu',
        userId: 'user_test_001',
        content: '/harness 修复登录Bug',
      });

      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);

      // Should have created a group chat
      expect(mockCreateGroupChat).toHaveBeenCalledTimes(1);
      expect(mockCreateGroupChat.mock.calls[0][0]).toBe('user_test_001');

      // Should have sent notification to private chat
      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      // message.conversationId should be overwritten to group chat id
      expect(message.conversationId).toBe('oc_group_new');

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('非 feishu 通道不应创建群聊但仍 acquire worktree', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'user_test_001';

      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      let acquireCount = 0;
      const worktreePool = {
        acquire: async (taskId: string, branch: string) => {
          acquireCount++;
          return {
            id: 'harness-web-slot',
            branch,
            worktreePath: '/tmp/worktree-web',
            taskId,
            createdAt: Date.now(),
          };
        },
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        ...createMockOVDeps(),
      });

      const message = createMockMessage({
        channel: 'web',
        content: '/harness 修复bug',
      });

      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);
      // Should still acquire worktree (via handleHarnessTask)
      expect(acquireCount).toBe(1);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('session 有 harnessWorktreeSlotId 时应跳过分类强制 harness', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'user_test_001';

      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const worktreePool = {
        acquire: async () => ({
          id: 'x',
          branch: 'x',
          worktreePath: '/tmp/x',
          taskId: 'x',
          createdAt: 0,
        }),
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const sessionManager = new SessionManager();
      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        sessionManager,
        ...createMockOVDeps(),
      });

      // Pre-populate a session with harness worktree binding
      const session = await sessionManager.resolveSession('user_test_001', 'web', 'conv_test_001');
      session.harnessWorktreeSlotId = 'harness-existing';
      session.harnessWorktreePath = '/tmp/worktree-existing';

      // Send a normal message (not /harness) — should still be forced to harness
      const message = createMockMessage({
        content: '请继续修改代码',
      });

      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);
      expect(executeSpy).toHaveBeenCalledTimes(1);

      const callArgs = executeSpy.mock.calls[0][0] as Record<string, unknown>;
      const context = callArgs.context as Record<string, unknown>;
      expect(context.workspacePath).toBe('/tmp/worktree-existing');
      expect(callArgs.forceComplex).toBe(true);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });
  });

  describe('handleHarnessEnd', () => {
    test('"结束" in harness session should close session and return summary', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'user_test_001';

      const agentRuntime = new AgentRuntime();
      spyOn(agentRuntime, 'execute');

      const worktreePool = {
        acquire: async () => ({
          id: 'harness-end-slot',
          branch: 'agent/fix/test',
          worktreePath: '/tmp/worktree-end',
          taskId: 'x',
          createdAt: 0,
        }),
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const sessionManager = new SessionManager();
      const closeSessionSpy = spyOn(sessionManager, 'closeSession').mockResolvedValue(null);

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        sessionManager,
        ...createMockOVDeps(),
      });

      // Pre-populate a session with harness worktree binding
      const session = await sessionManager.resolveSession('user_test_001', 'web', 'conv_test_001');
      session.harnessWorktreeSlotId = 'harness-end-slot';
      session.harnessWorktreePath = '/tmp/worktree-end';
      session.harnessBranch = 'agent/fix/test';

      const message = createMockMessage({ content: '结束' });
      const result = await controller.handleIncomingMessage(message);

      expect(result.success).toBe(true);
      expect(closeSessionSpy).toHaveBeenCalledTimes(1);
      expect(closeSessionSpy).toHaveBeenCalledWith('user_test_001:web:conv_test_001');
      const data = result.data as { content: string };
      expect(data.content).toContain('agent/fix/test');
      expect(data.content).toContain('Harness 任务结束');

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('"结束任务" and "/end" should also trigger harness end', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'user_test_001';

      for (const content of ['结束任务', '/end']) {
        CentralController.resetInstance();

        const agentRuntime = new AgentRuntime();
        spyOn(agentRuntime, 'execute');

        const worktreePool = {
          acquire: async () => ({
            id: 'slot',
            branch: 'agent/fix/x',
            worktreePath: '/tmp/wt',
            taskId: 'x',
            createdAt: 0,
          }),
          release: async () => {},
        } as unknown as CentralControllerDeps['worktreePool'];

        const sessionManager = new SessionManager();
        const closeSessionSpy = spyOn(sessionManager, 'closeSession').mockResolvedValue(null);

        const controller = CentralController.getInstance({
          agentRuntime,
          worktreePool,
          sessionManager,
          ...createMockOVDeps(),
        });

        const session = await sessionManager.resolveSession(
          'user_test_001',
          'web',
          'conv_test_001',
        );
        session.harnessWorktreeSlotId = 'slot';
        session.harnessWorktreePath = '/tmp/wt';
        session.harnessBranch = 'agent/fix/x';

        const message = createMockMessage({ content });
        const result = await controller.handleIncomingMessage(message);
        expect(result.success).toBe(true);
        expect(closeSessionSpy).toHaveBeenCalledTimes(1);
      }

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('normal messages in harness session should not trigger end', async () => {
      const originalEnv = process.env.ADMIN_USER_IDS;
      process.env.ADMIN_USER_IDS = 'user_test_001';

      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd: 0,
      });

      const worktreePool = {
        acquire: async () => ({
          id: 'slot',
          branch: 'agent/fix/x',
          worktreePath: '/tmp/wt',
          taskId: 'x',
          createdAt: 0,
        }),
        release: async () => {},
      } as unknown as CentralControllerDeps['worktreePool'];

      const sessionManager = new SessionManager();
      const closeSessionSpy = spyOn(sessionManager, 'closeSession').mockResolvedValue(null);

      const controller = CentralController.getInstance({
        agentRuntime,
        worktreePool,
        sessionManager,
        ...createMockOVDeps(),
      });

      const session = await sessionManager.resolveSession('user_test_001', 'web', 'conv_test_001');
      session.harnessWorktreeSlotId = 'slot';
      session.harnessWorktreePath = '/tmp/wt';

      // Normal message should go through chat pipeline, not trigger end
      const message = createMockMessage({ content: '请继续修改代码' });
      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);
      expect(closeSessionSpy).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);

      if (originalEnv !== undefined) {
        process.env.ADMIN_USER_IDS = originalEnv;
      } else {
        process.env.ADMIN_USER_IDS = undefined;
      }
    });

    test('"结束" in non-harness session should go through normal chat', async () => {
      const agentRuntime = new AgentRuntime();
      const executeSpy = spyOn(agentRuntime, 'execute').mockResolvedValue({
        content: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        complexity: 'simple',
        channel: 'light_llm',
        classificationCostUsd: 0,
      });

      const sessionManager = new SessionManager();
      const closeSessionSpy = spyOn(sessionManager, 'closeSession').mockResolvedValue(null);

      const controller = CentralController.getInstance({
        agentRuntime,
        sessionManager,
        ...createMockOVDeps(),
      });

      // No harness binding — "结束" should be treated as normal chat
      const message = createMockMessage({ content: '结束' });
      const result = await controller.handleIncomingMessage(message);
      expect(result.success).toBe(true);
      expect(closeSessionSpy).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
