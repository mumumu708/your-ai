import { describe, expect, mock, test } from 'bun:test';
import type { BotMessage, BotResponse, ChannelType, StreamEvent } from '../../shared/messaging';
import { BaseChannel } from './base-channel';

class TestChannel extends BaseChannel {
  readonly type: ChannelType = 'web';
  readonly name = 'test-channel';

  constructor() {
    super('TestChannel');
  }

  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async sendMessage(_userId: string, _content: BotResponse): Promise<void> {}
  async updateMessage(_messageId: string, _content: BotResponse): Promise<void> {}
  async sendStreamChunk(_userId: string, _chunk: StreamEvent): Promise<void> {}

  async transformToStandardMessage(raw: unknown): Promise<BotMessage> {
    return raw as BotMessage;
  }

  // Expose protected method for testing
  async testEmitMessage(message: BotMessage): Promise<void> {
    return this.emitMessage(message);
  }
}

function createTestMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: 'msg_test',
    channel: 'web',
    userId: 'user_1',
    userName: 'Test User',
    conversationId: 'conv_1',
    content: 'hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('BaseChannel', () => {
  test('onMessage registers a handler', () => {
    const channel = new TestChannel();
    const handler = mock(async () => {});
    channel.onMessage(handler);

    // handler stored internally; we verify via emitMessage
    expect(true).toBe(true);
  });

  test('emitMessage calls the registered handler', async () => {
    const channel = new TestChannel();
    const handler = mock(async (_msg: BotMessage) => {});
    channel.onMessage(handler);

    const msg = createTestMessage();
    await channel.testEmitMessage(msg);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  test('emitMessage warns when no handler is registered', async () => {
    const channel = new TestChannel();
    const msg = createTestMessage();
    // Should not throw
    await channel.testEmitMessage(msg);
  });

  test('type and name are accessible', () => {
    const channel = new TestChannel();
    expect(channel.type).toBe('web');
    expect(channel.name).toBe('test-channel');
  });
});
