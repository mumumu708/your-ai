import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { StreamProtocol } from '../../../kernel/streaming/stream-protocol';
import { TelegramStreamAdapter, type TelegramStreamDeps } from './telegram-stream-adapter';

function createMockDeps(): TelegramStreamDeps & {
  sentMessages: Array<{ chatId: number; text: string }>;
  editedMessages: Array<{ chatId: number; messageId: number; text: string }>;
} {
  const deps = {
    sentMessages: [] as Array<{ chatId: number; text: string }>,
    editedMessages: [] as Array<{ chatId: number; messageId: number; text: string }>,
    sendMessage: async (chatId: number, text: string) => {
      deps.sentMessages.push({ chatId, text });
      return 42; // mock messageId
    },
    editMessage: async (chatId: number, messageId: number, text: string) => {
      deps.editedMessages.push({ chatId, messageId, text });
    },
  };
  return deps;
}

function createProtocol(overrides: Partial<StreamProtocol> = {}): StreamProtocol {
  return {
    type: 'text_delta',
    data: {},
    metadata: { messageId: 'msg_001', sequenceNumber: 1, timestamp: Date.now() },
    ...overrides,
  };
}

describe('TelegramStreamAdapter', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('首次 chunk 应该发送新消息', async () => {
    const deps = createMockDeps();
    const adapter = new TelegramStreamAdapter(12345, deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());

    expect(deps.sentMessages.length).toBe(1);
    expect(deps.sentMessages[0].chatId).toBe(12345);
    expect(deps.sentMessages[0].text).toBe('Hello');
  });

  test('后续 chunk 应该编辑消息', async () => {
    const deps = createMockDeps();
    const adapter = new TelegramStreamAdapter(12345, deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendChunk(' World', createProtocol());

    expect(deps.sentMessages.length).toBe(1);
    expect(deps.editedMessages.length).toBe(1);
    expect(deps.editedMessages[0].text).toBe('Hello World');
    expect(deps.editedMessages[0].messageId).toBe(42);
  });

  test('sendDone 应该发送最终文本', async () => {
    const deps = createMockDeps();
    const adapter = new TelegramStreamAdapter(12345, deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hi', createProtocol());
    await adapter.sendDone('Hi there!', createProtocol({ type: 'stream_end' }));

    const lastEdit = deps.editedMessages[deps.editedMessages.length - 1];
    expect(lastEdit.text).toBe('Hi there!');
  });

  test('sendError 应该在消息中显示错误', async () => {
    const deps = createMockDeps();
    const adapter = new TelegramStreamAdapter(12345, deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('partial', createProtocol());
    await adapter.sendError('timeout', createProtocol({ type: 'error' }));

    const lastEdit = deps.editedMessages[deps.editedMessages.length - 1];
    expect(lastEdit.text).toContain('partial');
    expect(lastEdit.text).toContain('timeout');
  });

  test('无消息时的 sendError 应该发送新消息', async () => {
    const deps = createMockDeps();
    const adapter = new TelegramStreamAdapter(12345, deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendError('timeout', createProtocol({ type: 'error' }));

    expect(deps.sentMessages.length).toBe(1);
    expect(deps.sentMessages[0].text).toContain('timeout');
  });

  test('throttled flush error 应该被捕获', async () => {
    const deps = createMockDeps();
    // Make editMessage always reject
    deps.editMessage = async () => {
      throw new Error('edit failed');
    };
    const adapter = new TelegramStreamAdapter(12345, deps, 200);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('A', createProtocol()); // sends new message
    await adapter.sendChunk('B', createProtocol()); // throttled, schedules timer

    // Wait for the timer to fire and trigger flushUpdate → editMessage → catch
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Should not throw — error is caught by .catch block (line 51)
  });

  test('2000ms 节流应该限制 editMessage 频率', async () => {
    const deps = createMockDeps();
    const adapter = new TelegramStreamAdapter(12345, deps, 200); // 200ms for test

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('A', createProtocol());
    expect(deps.sentMessages.length).toBe(1); // First message sent

    await adapter.sendChunk('B', createProtocol());
    expect(deps.editedMessages.length).toBe(0); // Throttled

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(deps.editedMessages.length).toBe(1); // Now updated
    expect(deps.editedMessages[0].text).toBe('AB');

    await adapter.sendDone('AB final', createProtocol({ type: 'stream_end' }));
  });
});
