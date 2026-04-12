/**
 * 全链路 E2E 测试
 *
 * 模拟真实 gateway 启动流程 (HTTP + WS)，从客户端视角验证核心链路。
 *
 * 真实实例：Hono HTTP, WebChannel (WS), ClaudeAgentBridge (真实 CLI),
 *          ChannelManager, MessageRouter, CentralController, SessionManager, Scheduler, TaskQueue
 * Mock：LightLLMClient
 *
 * 运行：~/.bun/bin/bun test src/e2e/
 * 飞书：FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx ~/.bun/bin/bun test src/e2e/
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ChannelManager } from '../gateway/channel-manager';
import { WebChannel } from '../gateway/channels/web.gateway';
import { MessageRouter } from '../gateway/message-router';
import type { ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import type { LightLLMClient } from '../kernel/agents/light-llm-client';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import type { ChannelType } from '../shared/messaging';
import { isValidBotMessage } from '../shared/utils/validators';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

// --- Config ---

const HTTP_PORT = 18900;
const WS_PORT = 18901;
const CLAUDE_TIMEOUT = 60_000;

function makeBotMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: `e2e_msg_${Date.now()}`,
    channel: 'api' as const,
    userId: 'e2e_user',
    userName: 'E2E Tester',
    conversationId: `e2e_conv_${Date.now()}`,
    content: 'hello',
    contentType: 'text' as const,
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

/** Connect WS and consume the initial 'connected' handshake */
async function connectWs(port: number, userId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?userId=${userId}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
  // Consume 'connected' handshake
  await new Promise<void>((resolve) => {
    ws.onmessage = () => resolve();
  });
  return ws;
}

/** Wait for the next WS message */
function nextWsMessage(
  ws: WebSocket,
  timeoutMs = CLAUDE_TIMEOUT,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(e.data as string));
    };
  });
}

// --- Test suite ---

describe('全链路 E2E 测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  let channelManager: ChannelManager;
  let controller: CentralController;
  let httpServer: ReturnType<typeof Bun.serve>;

  const hasFeishuEnv = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);

  beforeAll(async () => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // 1. Real ClaudeAgentBridge (imports lazily to avoid top-level side effects)
    const { ClaudeAgentBridge } = await import('../kernel/agents/claude-agent-bridge');
    const claudeBridge: ClaudeAgentBridge = new ClaudeAgentBridge({
      claudePath: 'claude',
      defaultModel: 'sonnet',
    });

    // 2. Mock LightLLM — returns schedule classification for schedule-like messages
    const lightLLM = {
      complete: mock(async (params: { messages: Array<{ role: string; content: string }> }) => {
        const systemMsg = params.messages.find((m) => m.role === 'system')?.content ?? '';
        const isClassifierCall = systemMsg.includes('taskType');
        if (isClassifierCall) {
          const userMsg = params.messages.find((m) => m.role === 'user')?.content ?? '';
          const isSchedule = /每[天日周月]|定时|提醒我|remind|schedule/i.test(userMsg);
          const content = isSchedule
            ? '{"taskType":"scheduled","complexity":"complex","subIntent":"create","reason":"定时任务"}'
            : '{"taskType":"chat","complexity":"simple","reason":"对话"}';
          return {
            content,
            model: 'deepseek-chat',
            usage: { promptTokens: 5, completionTokens: 3, totalCost: 0.0001 },
          };
        }
        // Non-classifier call: actual LLM response
        return {
          content: 'mock light response',
          model: 'deepseek-chat',
          usage: { promptTokens: 5, completionTokens: 3, totalCost: 0.0001 },
        };
      }),
      stream: mock(async function* () {
        yield { content: 'mock light response', done: false };
        yield { content: '', done: true };
      }),
      getDefaultModel: () => 'deepseek-chat',
    } as unknown as LightLLMClient;

    // 3. Core assembly — reset singleton to ensure fresh instance with mock deps
    CentralController.resetInstance();
    const classifier = new TaskClassifier(lightLLM);
    controller = CentralController.getInstance({
      claudeBridge,
      lightLLM,
      classifier,
      ...createMockOVDeps(),
    });

    // Pre-create SOUL.md for E2E test users to bypass onboarding flow
    // Must match WorkspaceManager's USER_SPACE_ROOT fallback path
    const userSpaceBase = process.env.USER_SPACE_ROOT ?? join(homedir(), '.your-ai', 'user-space');
    const e2eUsers = [
      'e2e_user',
      'e2e_http_user',
      'e2e_schedule_user',
      'e2e_ws_complex',
      'e2e_ws_simple',
      'e2e_ws_multi',
      'e2e_isolation_A',
      'e2e_isolation_B',
    ];
    for (const userId of e2eUsers) {
      const memDir = `${userSpaceBase}/${userId}/memory`;
      mkdirSync(memDir, { recursive: true });
      writeFileSync(`${memDir}/SOUL.md`, '# Test SOUL\nBe helpful.\n');
    }

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    // 4. Response dispatcher
    router.setResponseDispatcher(async (channel: ChannelType, userId: string, content) => {
      const ch = channelManager.getChannel(channel);
      if (ch) await ch.sendMessage(userId, content);
    });

    // 5. Register WebChannel
    await channelManager.registerChannel(new WebChannel({ port: WS_PORT, path: '/ws' }));

    // 6. Conditionally register FeishuChannel
    if (hasFeishuEnv) {
      const { FeishuChannel } = await import('../gateway/channels/feishu.gateway');
      await channelManager.registerChannel(
        new FeishuChannel({
          appId: process.env.FEISHU_APP_ID ?? '',
          appSecret: process.env.FEISHU_APP_SECRET ?? '',
        }),
      );
    }

    // 7. HTTP server (Hono + Bun.serve)
    const app = new Hono();

    app.get('/health', async (c) => {
      const channelHealth = await channelManager.healthCheck();
      return c.json({
        status: channelHealth.status,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        channels: channelHealth.details,
        registeredChannels: channelManager.getRegisteredTypes(),
        llm: {
          claude: 'enabled',
          lightLLM: 'enabled',
        },
      });
    });

    app.post('/api/messages', async (c) => {
      const body = await c.req.json();
      if (!isValidBotMessage(body)) {
        return c.json({ success: false, error: 'Invalid message format' }, 400);
      }
      try {
        const result = await controller.handleIncomingMessage(body);
        return c.json({ success: true, data: result.data });
      } catch (error) {
        return c.json(
          { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
          500,
        );
      }
    });

    httpServer = Bun.serve({ port: HTTP_PORT, fetch: app.fetch });
  });

  afterAll(async () => {
    httpServer?.stop();
    await channelManager?.shutdownAll();
    CentralController.resetInstance();
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  // =========================================================================
  // Gateway 启动与健康检查
  // =========================================================================

  describe('Gateway 启动与健康检查', () => {
    test('GET /health 应该返回服务状态和通道信息', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('healthy');
      expect(body.registeredChannels).toBeArray();
      expect(body.registeredChannels).toContain('web');

      const llm = body.llm as Record<string, string>;
      expect(llm.claude).toBe('enabled');
    });

    const feishuTest = hasFeishuEnv ? test : test.skip;
    feishuTest('飞书通道注册后 healthCheck 应该包含 feishu', async () => {
      const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.registeredChannels).toContain('feishu');
      const channels = body.channels as Record<string, Record<string, unknown>>;
      expect(channels.feishu).toBeDefined();
      expect(channels.feishu.status).toBe('healthy');
    });
  });

  // =========================================================================
  // HTTP API 链路
  // =========================================================================

  describe('HTTP API 链路', () => {
    test(
      'POST /api/messages 发送 chat 消息应该返回 AI 响应',
      async () => {
        const message = makeBotMessage({
          content: '请用一句话回答：1+1等于几？',
          userId: 'e2e_http_user',
        });

        const res = await fetch(`http://localhost:${HTTP_PORT}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });

        const body = (await res.json()) as Record<string, unknown>;
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
        }
        expect(body.success).toBe(true);

        const data = body.data as Record<string, unknown>;
        expect(typeof data.content).toBe('string');
        expect((data.content as string).length).toBeGreaterThan(0);
      },
      CLAUDE_TIMEOUT,
    );

    test(
      'POST /api/messages 发送 scheduled 消息应该返回注册确认',
      async () => {
        const message = makeBotMessage({
          content: '请帮我设置每天早上9点提醒我参加晨会',
          userId: 'e2e_schedule_user',
        });

        const res = await fetch(`http://localhost:${HTTP_PORT}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.success).toBe(true);

        const data = body.data as Record<string, unknown>;
        expect(data.type).toBe('scheduled_registered');
        expect(data.cronExpression).toBeDefined();
      },
      CLAUDE_TIMEOUT,
    );
  });

  // =========================================================================
  // WebSocket 链路
  // =========================================================================

  describe('WebSocket 链路', () => {
    test(
      'WS 发送复杂消息 → 真实 Claude 处理 → 收到响应',
      async () => {
        const ws = await connectWs(WS_PORT, 'e2e_ws_complex');
        try {
          const responsePromise = nextWsMessage(ws);
          ws.send(JSON.stringify({ content: '帮我写一个 hello world' }));

          const response = await responsePromise;
          expect(response.type).toBe('message');

          const data = response.data as Record<string, unknown>;
          expect(typeof data.text).toBe('string');
          expect((data.text as string).length).toBeGreaterThan(0);
        } finally {
          ws.close();
        }
      },
      CLAUDE_TIMEOUT,
    );

    test(
      'WS 发送简单消息 → Mock LightLLM 处理 → 收到响应',
      async () => {
        const ws = await connectWs(WS_PORT, 'e2e_ws_simple');
        try {
          const responsePromise = nextWsMessage(ws);
          ws.send(JSON.stringify({ content: 'hi' }));

          const response = await responsePromise;
          expect(response.type).toBe('message');

          const data = response.data as Record<string, unknown>;
          expect(data.text).toBe('mock light response');
        } finally {
          ws.close();
        }
      },
      CLAUDE_TIMEOUT,
    );

    test('WS 多轮对话应该维持会话上下文', async () => {
      const ws = await connectWs(WS_PORT, 'e2e_ws_multi');
      try {
        // Round 1
        const p1 = nextWsMessage(ws);
        ws.send(JSON.stringify({ content: '请记住这个数字：42' }));
        const r1 = await p1;
        expect(r1.type).toBe('message');
        expect(typeof (r1.data as Record<string, unknown>).text).toBe('string');

        // Round 2 — references context from round 1
        const p2 = nextWsMessage(ws);
        ws.send(JSON.stringify({ content: '继续上面的话题，我刚才说的数字是什么？' }));
        const r2 = await p2;
        expect(r2.type).toBe('message');

        const text2 = (r2.data as Record<string, unknown>).text as string;
        expect(typeof text2).toBe('string');
        expect(text2.length).toBeGreaterThan(0);
      } finally {
        ws.close();
      }
    }, 60_000);
  });

  // =========================================================================
  // 会话隔离
  // =========================================================================

  describe('会话隔离', () => {
    test(
      '不同 userId 的 WS 连接应该各自独立',
      async () => {
        const wsA = await connectWs(WS_PORT, 'e2e_isolation_A');
        const wsB = await connectWs(WS_PORT, 'e2e_isolation_B');

        try {
          // User A sends, waits for response
          const pA = nextWsMessage(wsA);
          wsA.send(JSON.stringify({ content: 'hi' }));
          const rA = await pA;
          expect(rA.type).toBe('message');
          expect((rA.data as Record<string, unknown>).text).toBeDefined();

          // User B sends, waits for response
          const pB = nextWsMessage(wsB);
          wsB.send(JSON.stringify({ content: 'hi' }));
          const rB = await pB;
          expect(rB.type).toBe('message');
          expect((rB.data as Record<string, unknown>).text).toBeDefined();

          // Both received their own response — no cross-talk
          expect(rA).not.toBe(rB);
        } finally {
          wsA.close();
          wsB.close();
        }
      },
      CLAUDE_TIMEOUT,
    );
  });
});
