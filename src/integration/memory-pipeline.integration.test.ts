/**
 * 集成测试: 会话记忆管道
 *
 * 测试完整的记忆提取流程:
 *   SessionManager 积累消息 → closeSession → SessionMemoryExtractor.extract
 *   → SessionSummary → onSessionClose 回调触发 OV commit
 *
 * 同时测试会话过期自动触发记忆提取的场景。
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ConversationMessage } from '../shared/agents/agent-instance.types';
import type { AgentBridgeResult, ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import { CentralController } from '../kernel/central-controller';
import type { CentralControllerDeps } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { SessionMemoryExtractor } from '../kernel/memory/session-memory-extractor';
import type { SessionSummary } from '../kernel/memory/memory-types';
import { SessionManager } from '../kernel/sessioning/session-manager';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';

// ── Test helpers ──────────────────────────────────────────

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}`,
    channel: 'web',
    userId: 'user_mem',
    userName: 'Memory Tester',
    conversationId: 'conv_mem',
    content: '帮我创建一个 React 组件',
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

/** Creates mock OV deps for CentralController integration tests */
function createMockOVDeps(): Partial<CentralControllerDeps> {
  return {
    knowledgeRouter: {
      buildContext: async () => ({
        systemPrompt: '--- Agent Identity ---\nTest Agent',
        fragments: [],
        totalTokens: 10,
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
      loadAll: async () => ({ soul: '', identity: 'Test', user: '', agents: '' }),
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

// ── Tests ─────────────────────────────────────────────────

describe('会话记忆管道集成测试', () => {
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

  // ── SessionManager → SessionMemoryExtractor 提取 ───────

  describe('SessionManager → SessionMemoryExtractor 提取', () => {
    test('关闭会话时应该提取记忆摘要', async () => {
      const sessionManager = new SessionManager();
      const session = await sessionManager.resolveSession('user_mem', 'web', 'conv_extract');
      const sessionKey = 'user_mem:web:conv_extract';

      // 添加对话消息
      const now = Date.now();
      sessionManager.addMessage(sessionKey, {
        role: 'user',
        content: '帮我创建一个 React 组件用来展示用户列表',
        timestamp: now,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'assistant',
        content: '好的，我来帮你创建一个 UserList React 组件',
        timestamp: now + 1000,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'user',
        content: '请用 TypeScript 写，我喜欢使用函数组件',
        timestamp: now + 2000,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'assistant',
        content: '没问题，这是用 TypeScript 编写的函数组件',
        timestamp: now + 3000,
      });

      const summary = await sessionManager.closeSession(sessionKey);

      expect(summary).not.toBeNull();
      expect(summary!.sessionId).toBe(session.id);
      expect(summary!.userId).toBe('user_mem');
      expect(summary!.messageCount).toBe(4);
      expect(summary!.keywords.length).toBeGreaterThan(0);
      expect(summary!.startedAt).toBe(now);
      expect(summary!.endedAt).toBe(now + 3000);
    });

    test('会话消息中的行动项和偏好应该被提取', async () => {
      const sessionManager = new SessionManager();
      await sessionManager.resolveSession('user_mem', 'web', 'conv_pref');
      const sessionKey = 'user_mem:web:conv_pref';

      const now = Date.now();
      sessionManager.addMessage(sessionKey, {
        role: 'user',
        content: '帮我创建一个登录页面，我喜欢使用 Tailwind CSS',
        timestamp: now,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'assistant',
        content: '好的，我用 Tailwind CSS 来写',
        timestamp: now + 1000,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'user',
        content: '不要使用 class 组件，请用 hooks',
        timestamp: now + 2000,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'assistant',
        content: '明白，使用函数组件和 hooks',
        timestamp: now + 3000,
      });

      const summary = await sessionManager.closeSession(sessionKey);

      expect(summary).not.toBeNull();
      // '帮我创建一个登录页面' 匹配 ACTION_ITEM_PATTERNS
      expect(summary!.actionItems.length).toBeGreaterThan(0);
      // '我喜欢使用 Tailwind CSS' 和 '不要使用 class 组件' 匹配 PREFERENCE_PATTERNS
      expect(summary!.preferences.length).toBeGreaterThan(0);
    });
  });

  // ── SessionManager → OV commit 集成 ──────────────────

  describe('SessionManager → OV commit 集成', () => {
    test('onSessionClose 回调应该触发 OV commit', async () => {
      let commitCalledWith: string | null = null;
      const sessionManager = new SessionManager();

      // 设置 onSessionClose 回调 — simulates CentralController's behavior
      sessionManager.setOnSessionClose(async (summary: SessionSummary, sessionId: string) => {
        commitCalledWith = sessionId;
      });

      await sessionManager.resolveSession('user_mem', 'web', 'conv_store');
      const sessionKey = 'user_mem:web:conv_store';

      const now = Date.now();
      sessionManager.addMessage(sessionKey, {
        role: 'user',
        content: '帮我用 TypeScript 写一个工具函数',
        timestamp: now,
      });
      sessionManager.addMessage(sessionKey, {
        role: 'assistant',
        content: '好的，这是一个 TypeScript 工具函数',
        timestamp: now + 1000,
      });

      await sessionManager.closeSession(sessionKey);

      expect(commitCalledWith).not.toBeNull();
    });

    test('多次会话关闭应该每次都触发 OV commit', async () => {
      const commitCalls: string[] = [];
      const sessionManager = new SessionManager();

      sessionManager.setOnSessionClose(async (_summary: SessionSummary, sessionId: string) => {
        commitCalls.push(sessionId);
      });

      // 会话 1
      await sessionManager.resolveSession('user_mem', 'web', 'conv_1');
      const now = Date.now();
      sessionManager.addMessage('user_mem:web:conv_1', {
        role: 'user',
        content: '讨论 React 状态管理',
        timestamp: now,
      });
      sessionManager.addMessage('user_mem:web:conv_1', {
        role: 'assistant',
        content: '可以使用 Redux 或 Context API',
        timestamp: now + 1000,
      });
      await sessionManager.closeSession('user_mem:web:conv_1');

      // 会话 2
      await sessionManager.resolveSession('user_mem', 'web', 'conv_2');
      sessionManager.addMessage('user_mem:web:conv_2', {
        role: 'user',
        content: '讨论 Node.js 性能优化',
        timestamp: now + 5000,
      });
      sessionManager.addMessage('user_mem:web:conv_2', {
        role: 'assistant',
        content: '可以使用缓存和集群模式',
        timestamp: now + 6000,
      });
      await sessionManager.closeSession('user_mem:web:conv_2');

      // 会话 3
      await sessionManager.resolveSession('user_mem', 'web', 'conv_3');
      sessionManager.addMessage('user_mem:web:conv_3', {
        role: 'user',
        content: '讨论 Docker 部署策略',
        timestamp: now + 10000,
      });
      sessionManager.addMessage('user_mem:web:conv_3', {
        role: 'assistant',
        content: '推荐使用多阶段构建',
        timestamp: now + 11000,
      });
      await sessionManager.closeSession('user_mem:web:conv_3');

      expect(commitCalls.length).toBe(3);
    });
  });

  // ── CentralController → 会话过期 → 记忆提取 ────────────

  describe('CentralController → 会话过期 → 记忆提取', () => {
    test('会话过期后新消息应该触发旧会话关闭并提取记忆', async () => {
      const sessionManager = new SessionManager({ sessionTimeoutMs: 50 });
      let closedSummary: SessionSummary | null = null;

      sessionManager.setOnSessionClose(async (summary: SessionSummary) => {
        closedSummary = summary;
      });

      const controller = CentralController.getInstance({
        claudeBridge: createMockClaudeBridge(),
        classifier: new TaskClassifier(null),
        sessionManager,
        ...createMockOVDeps(),
      });

      // 第一条消息建立会话
      await controller.handleIncomingMessage(
        createMessage({ content: 'hello', userId: 'user_expire', conversationId: 'conv_expire' }),
      );

      // 获取当前会话并手动过期
      const sessionKey = 'user_expire:web:conv_expire';
      const session = sessionManager.getSessionByKey(sessionKey);
      expect(session).toBeDefined();
      session!.lastActiveAt = Date.now() - 100000;

      // 第二条消息应触发旧会话关闭 + 新会话创建
      await controller.handleIncomingMessage(
        createMessage({ content: 'world', userId: 'user_expire', conversationId: 'conv_expire' }),
      );

      // 旧会话应已关闭
      expect(session!.status).toBe('closed');
      const newSession = sessionManager.getSessionByKey(sessionKey);
      expect(newSession).toBeDefined();
      expect(newSession!.id).not.toBe(session!.id);
    });

    test('LLM 增强提取函数应该在设置后被调用', async () => {
      const llmExtractFn = mock(async (prompt: string) => {
        return '用户讨论了 React 组件开发，偏好 TypeScript 和函数组件';
      });

      const sessionManager = new SessionManager();
      // memoryExtractor 是 readonly 内联初始化，通过类型断言访问并设置 llmExtract
      (sessionManager as unknown as { memoryExtractor: SessionMemoryExtractor }).memoryExtractor.setLlmExtract(llmExtractFn);

      await sessionManager.resolveSession('user_mem', 'web', 'conv_llm');
      const sessionKey = 'user_mem:web:conv_llm';

      // 添加 >= 5 条消息以触发 LLM 增强
      const now = Date.now();
      const messages: ConversationMessage[] = [
        { role: 'user', content: '帮我创建 React 组件', timestamp: now },
        { role: 'assistant', content: '好的，创建什么样的组件？', timestamp: now + 1000 },
        { role: 'user', content: '一个用户列表组件', timestamp: now + 2000 },
        { role: 'assistant', content: '好的，使用 TypeScript 吗？', timestamp: now + 3000 },
        { role: 'user', content: '是的，我喜欢使用 TypeScript', timestamp: now + 4000 },
      ];

      for (const msg of messages) {
        sessionManager.addMessage(sessionKey, msg);
      }

      const summary = await sessionManager.closeSession(sessionKey);

      expect(summary).not.toBeNull();
      expect(llmExtractFn).toHaveBeenCalledTimes(1);
      // LLM 返回的摘要应被使用
      expect(summary!.summary).toContain('React');
    });
  });
});
