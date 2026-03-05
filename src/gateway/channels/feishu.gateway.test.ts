import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock @larksuiteoapi/node-sdk before importing the channel
const mockCreate = mock(() => Promise.resolve({ message_id: 'mock_msg_id' }));
const mockPatch = mock(() => Promise.resolve({}));
const mockWsStart = mock(() => Promise.resolve());
const mockWsClose = mock(() => {});
let _capturedEventHandler: ((data: unknown) => Promise<void>) | null = null;

mock.module('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    im = {
      message: {
        create: mockCreate,
        patch: mockPatch,
      },
    };
  },
  WSClient: class MockWSClient {
    start = mockWsStart;
    close = mockWsClose;
  },
  EventDispatcher: class MockEventDispatcher {
    register(handlers: Record<string, (data: unknown) => Promise<void>>) {
      _capturedEventHandler = handlers['im.message.receive_v1'] ?? null;
      return this;
    }
  },
}));

import { FeishuChannel } from './feishu.gateway';

const TEST_CONFIG = { appId: 'test_app_id', appSecret: 'test_app_secret' };

describe('FeishuChannel', () => {
  let channel: FeishuChannel;

  beforeEach(() => {
    channel = new FeishuChannel(TEST_CONFIG);
    mockCreate.mockClear();
    mockPatch.mockClear();
    mockWsStart.mockClear();
    mockWsClose.mockClear();
    _capturedEventHandler = null;
  });

  test('has correct type and name', () => {
    expect(channel.type).toBe('feishu');
    expect(channel.name).toBe('feishu');
  });

  test('initialize creates clients and starts WebSocket long connection', async () => {
    expect(channel.isConnected()).toBe(false);

    await channel.initialize();

    expect(mockWsStart).toHaveBeenCalledTimes(1);
    // start() should receive { eventDispatcher }
    const startArg = mockWsStart.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(startArg.eventDispatcher).toBeDefined();
    expect(channel.isConnected()).toBe(true);
  });

  test('initialize should throw and set connected=false when start() fails', async () => {
    mockWsStart.mockImplementationOnce(() => Promise.reject(new Error('connection refused')));

    try {
      await channel.initialize();
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain('飞书长连接建立失败');
    }
    expect(channel.isConnected()).toBe(false);
  });

  test('sendMessage calls im.message.create', async () => {
    await channel.initialize();
    await channel.sendMessage('user_open_id', { type: 'text', text: 'hello' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((callArgs.data as Record<string, unknown>).receive_id).toBe('user_open_id');
  });

  test('updateMessage calls im.message.patch', async () => {
    await channel.initialize();
    await channel.updateMessage('msg_123', { type: 'text', text: 'updated' });
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const callArgs = mockPatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((callArgs.path as Record<string, unknown>).message_id).toBe('msg_123');
  });

  test('transformToStandardMessage converts feishu event', async () => {
    const rawEvent = {
      sender: {
        sender_id: { open_id: 'ou_abc', union_id: 'on_xyz' },
      },
      message: {
        message_id: 'om_123',
        chat_id: 'oc_456',
        message_type: 'text',
        content: JSON.stringify({ text: '你好' }),
      },
    };

    const msg = await channel.transformToStandardMessage(rawEvent);
    expect(msg.id).toBe('om_123');
    expect(msg.channel).toBe('feishu');
    expect(msg.userId).toBe('ou_abc');
    expect(msg.content).toBe('你好');
    expect(msg.conversationId).toBe('oc_456');
    expect(msg.contentType).toBe('text');
  });

  test('sendStreamChunk sends initial message and updates', async () => {
    await channel.initialize();

    await channel.sendStreamChunk('user_1', { type: 'text_delta', text: 'Hello' });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    await channel.sendStreamChunk('user_1', { type: 'text_delta', text: ' world' });
    expect(mockPatch).toHaveBeenCalledTimes(1);

    await channel.sendStreamChunk('user_1', { type: 'done' });
    // Buffer should be cleared
  });

  test('shutdown calls wsClient.close and clears state', async () => {
    await channel.initialize();
    expect(channel.isConnected()).toBe(true);

    await channel.shutdown();
    expect(mockWsClose).toHaveBeenCalledTimes(1);
    expect(mockWsClose.mock.calls[0]?.[0]).toEqual({ force: true });
    expect(channel.isConnected()).toBe(false);
  });
});
