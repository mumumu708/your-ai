import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { StreamProtocol } from '../../../kernel/streaming/stream-protocol';
import { WebStreamAdapter, type WebStreamDeps } from './web-stream-adapter';

function createMockDeps(): WebStreamDeps & {
  sentMessages: Array<{ userId: string; data: unknown }>;
} {
  const deps = {
    sentMessages: [] as Array<{ userId: string; data: unknown }>,
    sendJson: (userId: string, data: unknown) => {
      deps.sentMessages.push({ userId, data });
    },
  };
  return deps;
}

function createProtocol(overrides: Partial<StreamProtocol> = {}): StreamProtocol {
  return {
    type: 'text_delta',
    data: { text: 'test' },
    metadata: { messageId: 'msg_001', sequenceNumber: 1, timestamp: Date.now() },
    ...overrides,
  };
}

describe('WebStreamAdapter', () => {
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

  test('onStreamStart 应该发送 stream_start 事件', async () => {
    const deps = createMockDeps();
    const adapter = new WebStreamAdapter('user_001', deps);

    await adapter.onStreamStart('msg_001');

    expect(deps.sentMessages.length).toBe(1);
    const msg = deps.sentMessages[0];
    expect(msg.userId).toBe('user_001');
    expect((msg.data as Record<string, unknown>).type).toBe('stream_start');
    expect((msg.data as Record<string, unknown>).messageId).toBe('msg_001');
  });

  test('sendChunk 应该实时推送每个 chunk', async () => {
    const deps = createMockDeps();
    const adapter = new WebStreamAdapter('user_001', deps);

    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendChunk(' World', createProtocol());

    // 2 chunks, no throttle
    expect(deps.sentMessages.length).toBe(2);
    expect((deps.sentMessages[0].data as Record<string, unknown>).type).toBe('stream');
    expect(
      ((deps.sentMessages[0].data as Record<string, unknown>).data as Record<string, unknown>).text,
    ).toBe('Hello');
  });

  test('sendDone 应该发送 stream_end 事件含完整文本', async () => {
    const deps = createMockDeps();
    const adapter = new WebStreamAdapter('user_001', deps);

    await adapter.sendDone('Hello World', createProtocol({ type: 'stream_end' }));

    expect(deps.sentMessages.length).toBe(1);
    const msg = deps.sentMessages[0];
    expect((msg.data as Record<string, unknown>).type).toBe('stream_end');
    expect(((msg.data as Record<string, unknown>).data as Record<string, unknown>).text).toBe(
      'Hello World',
    );
  });

  test('sendError 应该发送 stream_error 事件', async () => {
    const deps = createMockDeps();
    const adapter = new WebStreamAdapter('user_001', deps);

    await adapter.sendError('API failure', createProtocol({ type: 'error' }));

    expect(deps.sentMessages.length).toBe(1);
    const msg = deps.sentMessages[0];
    expect((msg.data as Record<string, unknown>).type).toBe('stream_error');
    expect(((msg.data as Record<string, unknown>).data as Record<string, unknown>).error).toBe(
      'API failure',
    );
  });

  test('metadata 应该正确传递', async () => {
    const deps = createMockDeps();
    const adapter = new WebStreamAdapter('user_001', deps);

    const protocol = createProtocol({
      metadata: { messageId: 'msg_42', sequenceNumber: 7, timestamp: 1234567890 },
    });
    await adapter.sendChunk('text', protocol);

    const meta = (deps.sentMessages[0].data as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(meta.messageId).toBe('msg_42');
    expect(meta.sequenceNumber).toBe(7);
  });
});
