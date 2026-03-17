import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock telegraf
const mockLaunch = mock(() => Promise.resolve());
const mockStop = mock(() => {});
const mockSendMessage = mock(() =>
  Promise.resolve({ message_id: 100, chat: { id: 123 }, date: 1000, text: 'ok' }),
);
const mockEditMessageText = mock(() => Promise.resolve({}));
const mockGetFileLink = mock(() =>
  Promise.resolve({ href: 'https://api.telegram.org/file/bot/test.jpg' }),
);
let capturedMessageHandler: ((ctx: unknown) => Promise<void>) | null = null;

mock.module('telegraf', () => ({
  Telegraf: class MockTelegraf {
    telegram = {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      getFileLink: mockGetFileLink,
    };

    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      if (event === 'message') {
        capturedMessageHandler = handler;
      }
    }

    launch = mockLaunch;
    stop = mockStop;
  },
}));

import { TelegramChannel } from './telegram.gateway';

const TEST_CONFIG = { botToken: 'test_bot_token' };

describe('TelegramChannel', () => {
  let channel: TelegramChannel;

  beforeEach(() => {
    channel = new TelegramChannel(TEST_CONFIG);
    mockLaunch.mockClear();
    mockStop.mockClear();
    mockSendMessage.mockClear();
    mockEditMessageText.mockClear();
    capturedMessageHandler = null;
  });

  test('has correct type and name', () => {
    expect(channel.type).toBe('telegram');
    expect(channel.name).toBe('telegram');
  });

  test('initialize registers handler and launches bot', async () => {
    await channel.initialize();
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(capturedMessageHandler).not.toBeNull();
  });

  test('sendMessage calls telegram.sendMessage', async () => {
    await channel.initialize();
    await channel.sendMessage('12345', { type: 'text', text: 'hello' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[0]).toBe(12345);
    expect(mockSendMessage.mock.calls[0]?.[1]).toBe('hello');
  });

  test('updateMessage calls telegram.editMessageText', async () => {
    await channel.initialize();
    await channel.updateMessage('12345:678', { type: 'text', text: 'updated' });
    expect(mockEditMessageText).toHaveBeenCalledTimes(1);
    expect(mockEditMessageText.mock.calls[0]?.[0]).toBe(12345);
    expect(mockEditMessageText.mock.calls[0]?.[1]).toBe(678);
  });

  test('transformToStandardMessage converts telegram message', async () => {
    const rawMsg = {
      message_id: 42,
      from: { id: 111, first_name: 'Alice', last_name: 'B' },
      chat: { id: 222, type: 'private' },
      text: 'hello bot',
      date: 1700000000,
    };

    const msg = await channel.transformToStandardMessage(rawMsg);
    expect(msg.id).toBe('tg_42');
    expect(msg.channel).toBe('telegram');
    expect(msg.userId).toBe('111');
    expect(msg.userName).toBe('Alice B');
    expect(msg.content).toBe('hello bot');
    expect(msg.conversationId).toBe('222');
    expect(msg.contentType).toBe('text');
    expect(msg.timestamp).toBe(1700000000000);
  });

  test('transformToStandardMessage handles photo messages', async () => {
    const rawMsg = {
      message_id: 43,
      from: { id: 111, first_name: 'Bob' },
      chat: { id: 222, type: 'private' },
      photo: [{ file_id: 'abc' }],
      caption: 'nice photo',
      date: 1700000000,
    };

    const msg = await channel.transformToStandardMessage(rawMsg);
    expect(msg.contentType).toBe('image');
    expect(msg.content).toBe('nice photo');
  });

  test('sendStreamChunk sends initial then updates', async () => {
    await channel.initialize();

    await channel.sendStreamChunk('123', { type: 'text_delta', text: 'Hi' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await channel.sendStreamChunk('123', { type: 'text_delta', text: ' there' });
    expect(mockEditMessageText).toHaveBeenCalledTimes(1);

    await channel.sendStreamChunk('123', { type: 'done' });
  });

  test('message handler emits message via emitMessage', async () => {
    await channel.initialize();
    const received: import('../../shared/messaging').BotMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await capturedMessageHandler!({
      message: {
        message_id: 99,
        from: { id: 555, first_name: 'Test' },
        chat: { id: 777, type: 'private' },
        text: 'hello via handler',
        date: 1700000000,
      },
    });

    expect(received.length).toBe(1);
    expect(received[0]?.content).toBe('hello via handler');
  });

  test('message handler catches errors gracefully', async () => {
    await channel.initialize();

    // Passing invalid message should trigger catch block
    await capturedMessageHandler!({ message: null });
    // Should not throw — error is caught and logged
  });

  test('shutdown stops the bot', async () => {
    await channel.initialize();
    await channel.shutdown();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test('transformToStandardMessage creates attachment for photo', async () => {
    const rawMsg = {
      message_id: 44,
      from: { id: 111, first_name: 'Alice' },
      chat: { id: 222, type: 'private' },
      photo: [
        { file_id: 'small', file_unique_id: 's1', width: 100, height: 100 },
        { file_id: 'large', file_unique_id: 'l1', width: 800, height: 600 },
      ],
      caption: 'my photo',
      date: 1700000000,
    };

    const msg = await channel.transformToStandardMessage(rawMsg);
    expect(msg.contentType).toBe('image');
    expect(msg.content).toBe('my photo');
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments).toHaveLength(1);
    const att = msg.attachments?.[0] as NonNullable<typeof msg.attachments>[0];
    expect(att.mediaType).toBe('image');
    expect(att.state).toBe('pending');
    expect(att.sourceRef).toEqual({
      channel: 'telegram',
      fileId: 'large',
      fileUniqueId: 'l1',
    });
  });

  test('transformToStandardMessage has no attachments for text messages', async () => {
    const rawMsg = {
      message_id: 45,
      from: { id: 111, first_name: 'Alice' },
      chat: { id: 222, type: 'private' },
      text: 'just text',
      date: 1700000000,
    };

    const msg = await channel.transformToStandardMessage(rawMsg);
    expect(msg.contentType).toBe('text');
    expect(msg.attachments).toBeUndefined();
  });

  test('getFileBuffer downloads file via bot API', async () => {
    const mockArrayBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockArrayBuffer),
      }),
    ) as typeof fetch;

    try {
      await channel.initialize();
      const buffer = await channel.getFileBuffer('file123');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBe(4);
      expect(mockGetFileLink).toHaveBeenCalledWith('file123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getFileBuffer throws on HTTP error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 404,
      }),
    ) as typeof fetch;

    try {
      await channel.initialize();
      await expect(channel.getFileBuffer('bad_file')).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
