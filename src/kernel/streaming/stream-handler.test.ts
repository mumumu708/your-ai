import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import { StreamHandler } from './stream-handler';
import type { ChannelStreamAdapter, StreamProtocol } from './stream-protocol';

function createMockAdapter(channelType = 'test'): ChannelStreamAdapter & {
  chunks: string[];
  errors: string[];
  doneText: string | null;
  started: boolean;
  protocols: StreamProtocol[];
} {
  const adapter = {
    channelType,
    chunks: [] as string[],
    errors: [] as string[],
    doneText: null as string | null,
    started: false,
    protocols: [] as StreamProtocol[],
    onStreamStart: async () => {
      adapter.started = true;
    },
    sendChunk: async (text: string, protocol: StreamProtocol) => {
      adapter.chunks.push(text);
      adapter.protocols.push(protocol);
    },
    sendDone: async (finalText: string, _protocol: StreamProtocol) => {
      adapter.doneText = finalText;
    },
    sendError: async (error: string, _protocol: StreamProtocol) => {
      adapter.errors.push(error);
    },
  };
  return adapter;
}

async function* createStreamSource(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('StreamHandler', () => {
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

  describe('processStream', () => {
    test('应该处理 text_delta 事件并发送到适配器', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const source = createStreamSource([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' World' },
        { type: 'done' },
      ]);

      const result = await handler.processStream(source, [adapter]);

      expect(result.fullContent).toBe('Hello World');
      expect(adapter.started).toBe(true);
      expect(adapter.chunks.length).toBeGreaterThanOrEqual(2);
      expect(adapter.doneText).toBe('Hello World');
    });

    test('应该通知多个适配器', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter1 = createMockAdapter('feishu');
      const adapter2 = createMockAdapter('web');

      const source = createStreamSource([{ type: 'text_delta', text: 'Hi' }, { type: 'done' }]);

      await handler.processStream(source, [adapter1, adapter2]);

      expect(adapter1.doneText).toBe('Hi');
      expect(adapter2.doneText).toBe('Hi');
    });

    test('应该在缓冲区满时 flush', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 99999, maxBufferSize: 5 },
      });
      const adapter = createMockAdapter();

      const source = createStreamSource([
        { type: 'text_delta', text: '12345' }, // 5 chars = maxBufferSize
        { type: 'text_delta', text: '67890' },
        { type: 'done' },
      ]);

      await handler.processStream(source, [adapter]);

      expect(adapter.chunks.length).toBeGreaterThanOrEqual(2);
      expect(adapter.doneText).toBe('1234567890');
    });

    test('应该处理 error 事件', async () => {
      const handler = new StreamHandler();
      const adapter = createMockAdapter();

      const source = createStreamSource([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'API failure' },
      ]);

      await handler.processStream(source, [adapter]);

      expect(adapter.errors.length).toBe(1);
      expect(adapter.errors[0]).toBe('API failure');
    });

    test('应该处理 tool_use 事件', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const source = createStreamSource([
        { type: 'text_delta', text: 'Let me search...' },
        { type: 'tool_use', toolName: 'search', toolInput: { q: 'test' } },
        { type: 'done' },
      ]);

      await handler.processStream(source, [adapter]);

      const toolChunk = adapter.chunks.find((c) => c.includes('工具调用'));
      expect(toolChunk).toBeDefined();
    });

    test('应该处理 tool_result 事件', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const source = createStreamSource([
        { type: 'tool_result', toolName: 'search', text: 'Found 3 results' },
        { type: 'done' },
      ]);

      await handler.processStream(source, [adapter]);

      expect(adapter.chunks.some((c) => c.includes('Found 3 results'))).toBe(true);
    });

    test('协议应该包含递增的 sequenceNumber', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const source = createStreamSource([
        { type: 'text_delta', text: 'a' },
        { type: 'text_delta', text: 'b' },
        { type: 'done' },
      ]);

      await handler.processStream(source, [adapter]);

      const seqs = adapter.protocols.map((p) => p.metadata.sequenceNumber);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    test('返回结果应该包含正确的统计', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const source = createStreamSource([{ type: 'text_delta', text: 'Hello' }, { type: 'done' }]);

      const result = await handler.processStream(source, [adapter]);

      expect(result.fullContent).toBe('Hello');
      expect(result.totalChunks).toBeGreaterThanOrEqual(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('空流应该正常处理', async () => {
      const handler = new StreamHandler();
      const adapter = createMockAdapter();

      const source = createStreamSource([{ type: 'done' }]);

      const result = await handler.processStream(source, [adapter]);

      expect(result.fullContent).toBe('');
      expect(adapter.doneText).toBe('');
    });
  });

  describe('createStreamCallback', () => {
    test('应该创建可用于 AgentRuntime 的回调', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const { callback, result } = handler.createStreamCallback([adapter]);

      callback({ type: 'text_delta', text: 'Hello' });
      callback({ type: 'text_delta', text: ' World' });
      callback({ type: 'done' });

      const streamResult = await result;

      expect(streamResult.fullContent).toBe('Hello World');
      expect(adapter.doneText).toBe('Hello World');
    });

    test('error 事件应该终止流', async () => {
      const handler = new StreamHandler({
        buffer: { flushIntervalMs: 0, maxBufferSize: 1 },
      });
      const adapter = createMockAdapter();

      const { callback, result } = handler.createStreamCallback([adapter]);

      callback({ type: 'text_delta', text: 'partial' });
      callback({ type: 'error', error: 'oops' });

      await result;

      expect(adapter.errors.length).toBe(1);
    });
  });
});
