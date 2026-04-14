import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { StreamProtocol } from '../../../kernel/streaming/stream-protocol';
import { FeishuStreamAdapter, type FeishuStreamDeps } from './feishu-stream-adapter';

function createMockDeps(): FeishuStreamDeps & {
  createdCards: Array<{ text: string }>;
  sentCardMessages: Array<{ chatId: string; cardId: string }>;
  textUpdates: Array<{ cardId: string; elementId: string; text: string; sequence: number }>;
  closedCards: string[];
  addedButtons: Array<{ cardId: string; buttons: string[] }>;
  sentTexts: Array<{ chatId: string; text: string }>;
} {
  const deps = {
    createdCards: [] as Array<{ text: string }>,
    sentCardMessages: [] as Array<{ chatId: string; cardId: string }>,
    textUpdates: [] as Array<{
      cardId: string;
      elementId: string;
      text: string;
      sequence: number;
    }>,
    closedCards: [] as string[],
    addedButtons: [] as Array<{ cardId: string; buttons: string[] }>,
    sentTexts: [] as Array<{ chatId: string; text: string }>,
    createStreamingCard: async (text: string) => {
      deps.createdCards.push({ text });
      return 'card_001';
    },
    sendCardMessage: async (chatId: string, cardId: string) => {
      deps.sentCardMessages.push({ chatId, cardId });
      return 'msg_001';
    },
    streamUpdateText: async (cardId: string, elementId: string, text: string, sequence: number) => {
      deps.textUpdates.push({ cardId, elementId, text, sequence });
    },
    closeStreamingMode: async (cardId: string) => {
      deps.closedCards.push(cardId);
    },
    addActionButtons: async (
      cardId: string,
      _afterElementId: string,
      buttons: string[],
      _sequence: number,
    ) => {
      deps.addedButtons.push({ cardId, buttons });
    },
    sendTextMessage: async (chatId: string, text: string) => {
      deps.sentTexts.push({ chatId, text });
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

  test('onStreamStart 应该创建流式卡片并发送消息', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');

    expect(deps.createdCards.length).toBe(1);
    expect(deps.createdCards[0].text).toBe('思考中...');
    expect(deps.sentCardMessages.length).toBe(1);
    expect(deps.sentCardMessages[0].chatId).toBe('chat_001');
    expect(deps.sentCardMessages[0].cardId).toBe('card_001');
  });

  test('sendChunk 应该通过 streamUpdateText 更新卡片', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());

    expect(deps.textUpdates.length).toBe(1);
    expect(deps.textUpdates[0].text).toBe('Hello');
    expect(deps.textUpdates[0].cardId).toBe('card_001');
    expect(deps.textUpdates[0].elementId).toBe('md_content');
  });

  test('后续 chunk 应该发送累积文本', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendChunk(' World', createProtocol());

    expect(deps.textUpdates.length).toBe(2);
    expect(deps.textUpdates[1].text).toBe('Hello World');
  });

  test('sendDone 应该发送最终文本、关闭流式模式并添加按钮', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendDone('Hello World', createProtocol({ type: 'stream_end' }));

    // Final text update
    const lastTextUpdate = deps.textUpdates[deps.textUpdates.length - 1];
    expect(lastTextUpdate.text).toBe('Hello World');

    // Streaming mode closed
    expect(deps.closedCards.length).toBe(1);
    expect(deps.closedCards[0]).toBe('card_001');

    // Action buttons added
    expect(deps.addedButtons.length).toBe(1);
    expect(deps.addedButtons[0].buttons).toEqual(['复制', '重新生成', '继续追问']);
  });

  test('sendError 应该更新卡片显示错误并关闭流式模式', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('partial', createProtocol());
    await adapter.sendError('API timeout', createProtocol({ type: 'error' }));

    const lastTextUpdate = deps.textUpdates[deps.textUpdates.length - 1];
    expect(lastTextUpdate.text).toContain('partial');
    expect(lastTextUpdate.text).toContain('API timeout');
    expect(deps.closedCards.length).toBe(1);
  });

  test('无卡片时的 sendError 应该降级发送文本消息', async () => {
    const deps = createMockDeps();
    // Make createStreamingCard fail
    deps.createStreamingCard = async () => {
      throw new Error('API error');
    };
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendError('API timeout', createProtocol({ type: 'error' }));

    expect(deps.sentTexts.length).toBe(1);
    expect(deps.sentTexts[0].text).toContain('API timeout');
  });

  test('CardKit 失败时应该降级为 fallback 文本模式', async () => {
    const deps = createMockDeps();
    deps.createStreamingCard = async () => {
      throw new Error('CardKit API error');
    };
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    // sendChunk should not throw in fallback mode
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendDone('Hello World', createProtocol({ type: 'stream_end' }));

    // Should have used sendTextMessage as fallback
    expect(deps.sentTexts.length).toBe(1);
    expect(deps.sentTexts[0].text).toBe('Hello World');
  });

  test('节流应该限制更新频率', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 200);

    await adapter.onStreamStart('msg_001');

    // First chunk goes through immediately
    await adapter.sendChunk('A', createProtocol());
    expect(deps.textUpdates.length).toBe(1);

    // Second chunk within throttle window should be deferred
    await adapter.sendChunk('B', createProtocol());
    expect(deps.textUpdates.length).toBe(1);

    // Wait for throttle to expire
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Now it should have updated
    expect(deps.textUpdates.length).toBe(2);
    expect(deps.textUpdates[1].text).toBe('AB');

    // sendDone should cancel any pending timer
    await adapter.sendDone('AB final', createProtocol({ type: 'stream_end' }));
  });

  test('节流延迟更新失败时应该记录错误', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 200);

    await adapter.onStreamStart('msg_001');

    // First chunk goes through immediately
    await adapter.sendChunk('A', createProtocol());
    expect(deps.textUpdates.length).toBe(1);

    // Make streamUpdateText fail for the deferred update
    deps.streamUpdateText = async () => {
      throw new Error('network error');
    };

    // Second chunk within throttle window should be deferred
    await adapter.sendChunk('B', createProtocol());
    expect(deps.textUpdates.length).toBe(1);

    // Wait for throttle to expire — the deferred flushUpdate will fail
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The error is caught and logged, not thrown
    expect(errorSpy).toHaveBeenCalled();
  });

  test('超长内容应该被截断保护', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');

    // Send a chunk that exceeds 28000 chars
    const longText = 'x'.repeat(30000);
    await adapter.sendChunk(longText, createProtocol());

    expect(deps.textUpdates.length).toBe(1);
    const updatedText = deps.textUpdates[0].text;
    expect(updatedText.length).toBeLessThanOrEqual(28000);
    expect(updatedText).toContain('内容已截断');
  });

  test('sequence 应该严格递增', async () => {
    const deps = createMockDeps();
    const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

    await adapter.onStreamStart('msg_001');
    await adapter.sendChunk('Hello', createProtocol());
    await adapter.sendChunk(' World', createProtocol());
    await adapter.sendDone('Hello World', createProtocol({ type: 'stream_end' }));

    const allSequences = deps.textUpdates.map((u) => u.sequence);
    for (let i = 1; i < allSequences.length; i++) {
      expect(allSequences[i]).toBeGreaterThan(allSequences[i - 1]);
    }
  });

  describe('内容过滤 (StreamContentFilter 集成)', () => {
    test('tool_start chunk 应该显示状态行而不是累积到正文', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk(
        '\n> 🔧 memory_search ...\n',
        createProtocol({ type: 'tool_start', data: { toolName: 'memory_search' } }),
      );

      expect(deps.textUpdates.length).toBe(1);
      // 状态行显示，而非原始 tool label 文本
      expect(deps.textUpdates[0].text).toBe('🔍 正在搜索记忆...');
    });

    test('tool_result chunk 应该被完全抑制', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk('Hello', createProtocol());
      const countAfterText = deps.textUpdates.length;

      await adapter.sendChunk('> ✅ 完成\n\n', createProtocol({ type: 'tool_result' }));

      // tool_result suppressed — no new update
      expect(deps.textUpdates.length).toBe(countAfterText);
    });

    test('tool_start 后跟 text_delta 应该合并显示：正文 + 状态行', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk('思考中', createProtocol());
      await adapter.sendChunk(
        '',
        createProtocol({ type: 'tool_start', data: { toolName: 'Bash' } }),
      );

      // Combined: contentBuffer + statusLine
      const lastUpdate = deps.textUpdates[deps.textUpdates.length - 1];
      expect(lastUpdate.text).toBe('思考中\n\n⚡ 正在执行命令...');
    });

    test('tool_start 后跟 text_delta 应该清除状态行', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk(
        '',
        createProtocol({ type: 'tool_start', data: { toolName: 'Bash' } }),
      );
      await adapter.sendChunk('结果回来了', createProtocol());

      // Status line cleared after text_delta
      const lastUpdate = deps.textUpdates[deps.textUpdates.length - 1];
      expect(lastUpdate.text).toBe('结果回来了');
      expect(lastUpdate.text).not.toContain('⚡');
    });

    test('仅有状态行时（无正文）应该正常显示状态行', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk(
        '',
        createProtocol({ type: 'tool_start', data: { toolName: 'Read' } }),
      );

      expect(deps.textUpdates.length).toBe(1);
      expect(deps.textUpdates[0].text).toBe('📄 正在读取文件...');
    });

    test('sendDone 最终渲染不应包含状态行', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk(
        '',
        createProtocol({ type: 'tool_start', data: { toolName: 'Bash' } }),
      );
      await adapter.sendDone('最终回复', createProtocol({ type: 'stream_end' }));

      const finalUpdate = deps.textUpdates[deps.textUpdates.length - 1];
      expect(finalUpdate.text).toBe('最终回复');
      expect(finalUpdate.text).not.toContain('⚡');
    });

    test('连续 tool_start 事件只保留最后一个状态行', async () => {
      const deps = createMockDeps();
      const adapter = new FeishuStreamAdapter('chat_001', deps, 0);

      await adapter.onStreamStart('msg_001');
      await adapter.sendChunk(
        '',
        createProtocol({ type: 'tool_start', data: { toolName: 'Read' } }),
      );
      await adapter.sendChunk(
        '',
        createProtocol({ type: 'tool_start', data: { toolName: 'Bash' } }),
      );

      const lastUpdate = deps.textUpdates[deps.textUpdates.length - 1];
      expect(lastUpdate.text).toBe('⚡ 正在执行命令...');
      expect(lastUpdate.text).not.toContain('📄');
    });
  });
});
