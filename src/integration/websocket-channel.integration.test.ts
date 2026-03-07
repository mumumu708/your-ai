/**
 * 集成测试: WebSocket 通道端到端
 *
 * 测试真实 WebSocket 连接经过完整管道:
 *   WebSocket Client → WebChannel → MessageRouter → CentralController → AgentRuntime → 响应回推 WS
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ChannelManager } from '../gateway/channel-manager';
import { WebChannel } from '../gateway/channels/web.gateway';
import { MessageRouter } from '../gateway/message-router';
import type { AgentBridgeResult, ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import type { ChannelType } from '../shared/messaging';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import { createMockLightLLM } from '../test-utils/mock-light-llm';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

const WS_PORT = 19877;

function createMockClaudeBridge(response = 'mock response'): ClaudeAgentBridge {
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

/** Helper: connect WS, consume initial 'connected' message */
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

/** Helper: wait for the next WS message */
function nextWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(e.data as string));
    };
  });
}

describe('WebSocket 通道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let channelManager: ChannelManager;
  let webChannel: WebChannel;

  beforeEach(() => {
    CentralController.resetInstance();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await channelManager?.shutdownAll();
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /** Build full pipeline and start WS server */
  async function setupPipeline(claudeResponse: string, lightLLMResponse?: string) {
    const claudeBridge = createMockClaudeBridge(claudeResponse);
    const lightLLM = lightLLMResponse ? createMockLightLLM(lightLLMResponse) : null;
    const classifier = new TaskClassifier(lightLLM);

    const controller = CentralController.getInstance({
      claudeBridge,
      lightLLM,
      classifier,
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    // Wire response dispatcher through channel manager
    router.setResponseDispatcher(async (channel: ChannelType, userId: string, content) => {
      const ch = channelManager.getChannel(channel);
      if (ch) {
        await ch.sendMessage(userId, content);
      }
    });

    webChannel = new WebChannel({ port: WS_PORT, path: '/ws' });
    await channelManager.registerChannel(webChannel);

    return { claudeBridge, lightLLM, controller, router };
  }

  test('WS 消息应该经过完整管道并收到 AI 响应', async () => {
    await setupPipeline('这是 AI 的回答');

    const ws = await connectWs(WS_PORT, 'ws_user_1');
    const responsePromise = nextWsMessage(ws);

    ws.send(JSON.stringify({ content: '帮我写代码' }));

    const response = await responsePromise;
    expect(response.type).toBe('message');
    expect((response.data as Record<string, unknown>).text).toBe('这是 AI 的回答');

    ws.close();
  });

  test('简单任务通过 LightLLM 处理后应该返回到 WS', async () => {
    await setupPipeline('claude answer', 'light answer');

    const ws = await connectWs(WS_PORT, 'ws_user_2');
    const responsePromise = nextWsMessage(ws);

    // "hi" should hit simple rule (<=10 chars)
    ws.send(JSON.stringify({ content: 'hi' }));

    const response = await responsePromise;
    expect(response.type).toBe('message');
    expect((response.data as Record<string, unknown>).text).toBe('light answer');

    ws.close();
  });

  test('多个 WS 客户端各自收到自己的响应', async () => {
    const { claudeBridge } = await setupPipeline('default');

    // Override to return different content per call
    let callCount = 0;
    (claudeBridge.execute as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      return {
        content: `reply_${callCount}`,
        toolsUsed: [],
        turns: 1,
        usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.001 },
      };
    });

    const ws1 = await connectWs(WS_PORT, 'multi_user_1');
    const ws2 = await connectWs(WS_PORT, 'multi_user_2');

    const p1 = nextWsMessage(ws1);
    ws1.send(JSON.stringify({ content: '帮我写一个函数' }));
    const r1 = await p1;

    const p2 = nextWsMessage(ws2);
    ws2.send(JSON.stringify({ content: '帮我修改代码' }));
    const r2 = await p2;

    expect((r1.data as Record<string, unknown>).text).toBe('reply_1');
    expect((r2.data as Record<string, unknown>).text).toBe('reply_2');

    ws1.close();
    ws2.close();
  });

  test('错误处理: AI 处理失败应该返回错误消息到 WS', async () => {
    const { claudeBridge } = await setupPipeline('unused');

    (claudeBridge.execute as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('AI processing failed');
    });

    const ws = await connectWs(WS_PORT, 'ws_err_user');
    const responsePromise = nextWsMessage(ws);

    ws.send(JSON.stringify({ content: '帮我debug' }));

    const response = await responsePromise;
    expect(response.type).toBe('message');
    expect((response.data as Record<string, unknown>).text).toContain('处理失败');

    ws.close();
  });

  test('无效 JSON 消息应该返回错误', async () => {
    await setupPipeline('unused');

    const ws = await connectWs(WS_PORT, 'ws_bad_msg');
    const responsePromise = nextWsMessage(ws);

    ws.send('not json {{{');

    const response = await responsePromise;
    expect(response.type).toBe('error');

    ws.close();
  });
});
