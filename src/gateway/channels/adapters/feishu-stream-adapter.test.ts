import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { StreamProtocol } from '../../../kernel/streaming/stream-protocol';
import { FeishuStreamAdapter, type FeishuStreamDeps } from './feishu-stream-adapter';

function createMockDeps(): FeishuStreamDeps & {
  createdCards: Array<{ chatId: string; text: string }>;
  updatedCards: Array<{ messageId: string; text: string; options?: unknown }>;
} {
  const deps = {
    createdCards: [] as Array<{ chatId: string; text: string }>,
    updatedCards: [] as Array<{ messageId: string; text: string; options?: unknown }>,
    createStreamCard: async (chatId: string, text: string) => {
      deps.createdCards.push({ chatId, text });
      return 'card_001';
    },
    updateCard: async (messageId: string, text: string, options?: unknown) => {
      deps.updatedCards.push({ messageId, text, options });
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

describe('FeishuStreamAdapter', () => {
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

  test('首次 chunk 应该创建流式卡片', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0); // No throttle for test

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());

    expect(deps.createdCards.length).toBe(1);
    expect(deps.createdCards[0].chatId).toBe('chat_001');
    expect(deps.createdCards[0].text).toBe('Hello');
  });

  test('后续 chunk 应该更新卡片', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendChunk(' World', createProtocol());

    expect(deps.createdCards.length).toBe(1);
    expect(deps.updatedCards.length).toBe(1);
    expect(deps.updatedCards[0].text).toBe('Hello World');
  });

  test('sendDone 应该发送带操作按钮的最终卡片', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendDone('Hello World', createProtocol({ type: 'stream_end' }));

    const lastUpdate = deps.updatedCards[deps.updatedCards.length - 1];
    expect(lastUpdate.text).toBe('Hello World');
    expect((lastUpdate.options as Record<string, unknown>)?.showActions).toBe(true);
  });

  test('sendError 应该更新卡片显示错误', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('partial', createProtocol());
    await adapter.sendError('API timeout', createProtocol({ type: 'error' }));

    const lastUpdate = deps.updatedCards[deps.updatedCards.length - 1];
    expect(lastUpdate.text).toContain('partial');
    expect(lastUpdate.text).toContain('API timeout');
  });

  test('无卡片时的 sendError 应该创建新卡片', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendError('API timeout', createProtocol({ type: 'error' }));

    expect(deps.createdCards.length).toBe(1);
    expect(deps.createdCards[0].text).toContain('API timeout');
  });

  test('节流应该限制更新频率', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 200); // 200ms throttle

    await adapter.onStreamStart('msg_001');

    // First chunk goes through immediately
    await adapter.sendChunk('A', createProtocol());
    expect(deps.createdCards.length).toBe(1);

    // Second chunk within throttle window should be deferred
    await adapter.sendChunk('B', createProtocol());
    // Should NOT have updated yet (within throttle window)
    expect(deps.updatedCards.length).toBe(0);

    // Wait for throttle to expire
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Now it should have updated
    expect(deps.updatedCards.length).toBe(1);
    expect(deps.updatedCards[0].text).toBe('AB');

    // sendDone should cancel any pending timer
    await adapter.sendDone('AB final', createProtocol({ type: 'stream_end' }));
  });
});
