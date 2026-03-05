/**
 * 集成测试: ChannelManager 多通道管理
 *
 * 测试 ChannelManager 注册通道 → 消息路由 → 响应分发到正确通道
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ChannelManager } from '../gateway/channel-manager';
import { WebChannel } from '../gateway/channels/web.gateway';
import { MessageRouter } from '../gateway/message-router';
import type { AgentBridgeResult, ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import type {
  BotMessage,
  BotResponse,
  ChannelType,
  IChannel,
  MessageHandler,
} from '../shared/messaging';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

const WS_PORT_A = 19878;
const WS_PORT_B = 19879;

function createMockClaudeBridge(response = 'reply'): ClaudeAgentBridge {
  return {
    execute: mock(
      async () =>
        ({
          content: response,
          toolsUsed: [],
          turns: 1,
          usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.001 },
        }) satisfies AgentBridgeResult,
    ),
    estimateCost: () => 0.001,
    getActiveSessions: () => 0,
  } as unknown as ClaudeAgentBridge;
}

/** Simple in-memory mock channel for non-WS channels (e.g. feishu, telegram) */
function createMockChannel(
  type: ChannelType,
  name: string,
): IChannel & {
  sent: Array<{ userId: string; content: BotResponse }>;
  receivedHandler: MessageHandler | null;
} {
  const sent: Array<{ userId: string; content: BotResponse }> = [];
  let handler: MessageHandler | null = null;

  return {
    type,
    name,
    sent,
    get receivedHandler() {
      return handler;
    },
    onMessage: (h: MessageHandler) => {
      handler = h;
    },
    initialize: mock(async () => {}),
    shutdown: mock(async () => {}),
    sendMessage: mock(async (userId: string, content: BotResponse) => {
      sent.push({ userId, content });
    }),
    sendStreamChunk: mock(async () => {}),
    updateMessage: mock(async () => {}),
    healthCheck: mock(async () => ({ status: 'healthy' as const, channel: type })),
  };
}

function createMessage(channel: ChannelType, userId: string, content: string): BotMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    channel,
    userId,
    userName: `User ${userId}`,
    conversationId: `conv_${userId}`,
    content,
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
  };
}

describe('ChannelManager 多通道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let channelManager: ChannelManager;

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

  test('多通道注册后 healthCheck 应该反映所有通道状态', async () => {
    const controller = CentralController.getInstance({
      claudeBridge: createMockClaudeBridge(),
      classifier: new TaskClassifier(null),
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    const mockFeishu = createMockChannel('feishu', 'feishu');
    const mockTelegram = createMockChannel('telegram', 'telegram');

    await channelManager.registerChannel(mockFeishu);
    await channelManager.registerChannel(mockTelegram);

    const health = await channelManager.healthCheck();
    expect(health.status).toBe('healthy');
    expect((health.details as Record<string, unknown>).feishu).toBeDefined();
    expect((health.details as Record<string, unknown>).telegram).toBeDefined();
    expect(channelManager.getRegisteredTypes()).toContain('feishu');
    expect(channelManager.getRegisteredTypes()).toContain('telegram');
  });

  test('不同通道的消息应该经过同一管道，响应分发到各自通道', async () => {
    const claudeBridge = createMockClaudeBridge();
    let callIdx = 0;
    (claudeBridge.execute as ReturnType<typeof mock>).mockImplementation(async () => {
      callIdx++;
      return {
        content: `reply_${callIdx}`,
        toolsUsed: [],
        turns: 1,
        usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.001 },
      };
    });

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    // Wire response dispatcher
    router.setResponseDispatcher(async (channel: ChannelType, userId: string, content) => {
      const ch = channelManager.getChannel(channel);
      if (ch) await ch.sendMessage(userId, content);
    });

    const feishuCh = createMockChannel('feishu', 'feishu');
    const telegramCh = createMockChannel('telegram', 'telegram');

    await channelManager.registerChannel(feishuCh);
    await channelManager.registerChannel(telegramCh);

    // Simulate messages from each channel
    const feishuHandler = feishuCh.receivedHandler;
    const telegramHandler = telegramCh.receivedHandler;
    expect(feishuHandler).not.toBeNull();
    expect(telegramHandler).not.toBeNull();

    await feishuHandler?.(createMessage('feishu', 'fs_user', '飞书消息'));
    await telegramHandler?.(createMessage('telegram', 'tg_user', 'telegram消息'));

    // Each channel should only receive its own response
    expect(feishuCh.sent).toHaveLength(1);
    expect(feishuCh.sent[0].userId).toBe('fs_user');
    expect((feishuCh.sent[0].content as { text: string }).text).toBe('reply_1');

    expect(telegramCh.sent).toHaveLength(1);
    expect(telegramCh.sent[0].userId).toBe('tg_user');
    expect((telegramCh.sent[0].content as { text: string }).text).toBe('reply_2');
  });

  test('重复注册同一类型通道应该抛错', async () => {
    const controller = CentralController.getInstance({
      claudeBridge: createMockClaudeBridge(),
      classifier: new TaskClassifier(null),
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    const ch1 = createMockChannel('feishu', 'feishu-1');
    const ch2 = createMockChannel('feishu', 'feishu-2');

    await channelManager.registerChannel(ch1);

    try {
      await channelManager.registerChannel(ch2);
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain('已注册');
    }
  });

  test('shutdownAll 应该关闭所有注册通道', async () => {
    const controller = CentralController.getInstance({
      claudeBridge: createMockClaudeBridge(),
      classifier: new TaskClassifier(null),
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    const feishuCh = createMockChannel('feishu', 'feishu');
    const telegramCh = createMockChannel('telegram', 'telegram');

    await channelManager.registerChannel(feishuCh);
    await channelManager.registerChannel(telegramCh);

    await channelManager.shutdownAll();

    expect(feishuCh.shutdown).toHaveBeenCalledTimes(1);
    expect(telegramCh.shutdown).toHaveBeenCalledTimes(1);
  });

  test('WebChannel + MockChannel 混合注册应该正常工作', async () => {
    const claudeBridge = createMockClaudeBridge('mixed reply');

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    router.setResponseDispatcher(async (channel: ChannelType, userId: string, content) => {
      const ch = channelManager.getChannel(channel);
      if (ch) await ch.sendMessage(userId, content);
    });

    const webCh = new WebChannel({ port: WS_PORT_A, path: '/ws' });
    const feishuCh = createMockChannel('feishu', 'feishu');

    await channelManager.registerChannel(webCh);
    await channelManager.registerChannel(feishuCh);

    const health = await channelManager.healthCheck();
    expect((health.details as Record<string, unknown>).web).toBeDefined();
    expect((health.details as Record<string, unknown>).feishu).toBeDefined();

    // Test feishu channel message goes through
    const feishuHandler = feishuCh.receivedHandler;
    expect(feishuHandler).not.toBeNull();
    await feishuHandler?.(createMessage('feishu', 'fs_mixed', '混合测试'));

    expect(feishuCh.sent).toHaveLength(1);
    expect((feishuCh.sent[0].content as { text: string }).text).toBe('mixed reply');
  });

  test('真实 WebSocket 通过 ChannelManager 注册后消息应该正常处理', async () => {
    const claudeBridge = createMockClaudeBridge('ws channelmanager reply');

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      ...createMockOVDeps(),
    });

    const router = new MessageRouter(controller);
    channelManager = new ChannelManager(router);

    router.setResponseDispatcher(async (channel: ChannelType, userId: string, content) => {
      const ch = channelManager.getChannel(channel);
      if (ch) await ch.sendMessage(userId, content);
    });

    const webCh = new WebChannel({ port: WS_PORT_B, path: '/ws' });
    await channelManager.registerChannel(webCh);

    // Connect real WS client
    const ws = new WebSocket(`ws://localhost:${WS_PORT_B}/ws?userId=cm_user`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    // Consume 'connected' message
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });

    const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
    });

    ws.send(JSON.stringify({ content: '帮我分析代码' }));

    const response = await responsePromise;
    expect(response.type).toBe('message');
    expect((response.data as Record<string, unknown>).text).toBe('ws channelmanager reply');

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
