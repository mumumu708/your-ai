/**
 * DD-020 Streaming Architecture Upgrade — Integration Tests
 *
 * Tests the full streaming pipeline:
 *   StreamEvent source → StreamBuffer → StreamHandler → ChannelStreamAdapter[]
 *
 * ST-01..ST-09: Direct StreamHandler/StreamBuffer/StreamContentFilter tests
 * ST-10..ST-14: Controller-level integration via createTestController
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBridge, AgentResult } from '../../kernel/agents/agent-bridge';
import { StreamContentFilter } from '../../kernel/streaming/stream-content-filter';
import { StreamHandler } from '../../kernel/streaming/stream-handler';
import type { StreamResult } from '../../kernel/streaming/stream-handler';
import type { ChannelStreamAdapter, StreamProtocol } from '../../kernel/streaming/stream-protocol';
import type { WorkspaceManager } from '../../kernel/workspace';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
import {
  cleanupController,
  createMessage,
  createMockLightLLM,
  createTestController,
} from './test-helpers';
import type { ControllerTestContext } from './test-helpers';

// ── Helpers ──────────────────────────────────────────────────

const TEST_USER_SPACE = join(tmpdir(), `your-ai-stream-test-${Date.now()}`);

/** Create an adapter that records all calls with full arguments */
function createCapturingAdapter(channelType = 'web') {
  const captured = {
    started: false,
    messageId: '',
    chunks: [] as { text: string; protocol: StreamProtocol }[],
    errors: [] as { error: string; protocol: StreamProtocol }[],
    doneText: '',
    doneProtocol: null as StreamProtocol | null,
  };
  const adapter: ChannelStreamAdapter = {
    channelType,
    onStreamStart: mock(async (messageId: string) => {
      captured.started = true;
      captured.messageId = messageId;
    }),
    sendChunk: mock(async (text: string, protocol: StreamProtocol) => {
      captured.chunks.push({ text, protocol });
    }),
    sendDone: mock(async (fullText: string, protocol: StreamProtocol) => {
      captured.doneText = fullText;
      captured.doneProtocol = protocol;
    }),
    sendError: mock(async (error: string, protocol: StreamProtocol) => {
      captured.errors.push({ error, protocol });
    }),
  };
  return { adapter, captured };
}

/** Create an async iterable from an array of StreamEvents */
async function* eventsFromArray(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

/** Create an async iterable that throws after emitting some events */
async function* eventsWithError(
  events: StreamEvent[],
  errorMessage: string,
): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
  throw new Error(errorMessage);
}

/**
 * WorkspaceManager mock that returns correct WorkspacePath shape (synchronous).
 * The default createMockWorkspaceManager in test-helpers returns the wrong shape,
 * causing `paths.absolutePath` to be undefined in the controller.
 */
function createCorrectWorkspaceManager(): WorkspaceManager {
  const basePath = join(TEST_USER_SPACE, 'user_test');
  return {
    initializeWithMcp: mock((_ctx: unknown) => ({
      absolutePath: basePath,
      claudeDir: join(basePath, '.claude'),
      settingsPath: join(basePath, '.claude', 'settings.json'),
      memoryDir: join(basePath, 'memory'),
      mcpJsonPath: join(basePath, '.mcp.json'),
      skillsDir: join(basePath, '.claude', 'skills'),
    })),
    getWorkspacePath: mock((_userId: string) => ({
      absolutePath: basePath,
      claudeDir: join(basePath, '.claude'),
      settingsPath: join(basePath, '.claude', 'settings.json'),
      memoryDir: join(basePath, 'memory'),
      mcpJsonPath: join(basePath, '.mcp.json'),
      skillsDir: join(basePath, '.claude', 'skills'),
    })),
  } as unknown as WorkspaceManager;
}

// ── Suppress logger output ───────────────────────��───────────

let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  // Ensure SOUL.md exists so onboarding is skipped
  const memDir = join(TEST_USER_SPACE, 'user_test', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'SOUL.md'), 'Test Agent', 'utf-8');
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ═══════════���═══════════════════════════════════════════════════
// ST-01 ~ ST-09: StreamHandler / StreamBuffer / Filter direct tests
// ═════════════════���══════════════════════════════���══════════════

describe('ST-01: text_delta → StreamBuffer → flush → sendChunk', () => {
  test('adapter.sendChunk is called and totalChunks increments', async () => {
    // Use a buffer that flushes immediately (maxBufferSize=1)
    const handler = new StreamHandler({ buffer: { maxBufferSize: 1, flushIntervalMs: 0 } });
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' World' },
      { type: 'done' },
    ];

    const result = await handler.processStream(eventsFromArray(events), [adapter]);

    expect(captured.started).toBe(true);
    expect(adapter.sendChunk).toHaveBeenCalled();
    expect(captured.chunks.length).toBeGreaterThanOrEqual(1);
    // totalChunks should match the number of text_delta flushes
    expect(result.totalChunks).toBeGreaterThanOrEqual(2);
    expect(result.fullContent).toBe('Hello World');
    // Verify chunk text aggregates to full content
    const allChunkText = captured.chunks
      .filter((c) => c.protocol.type === 'text_delta')
      .map((c) => c.text)
      .join('');
    expect(allChunkText).toBe('Hello World');
  });
});

describe('ST-02: buffer.shouldFlush()=false → no flush; done triggers forceFlush', () => {
  test('small text does not flush until done event forces it', async () => {
    // Large buffer + very long interval → shouldFlush returns false for small text
    const handler = new StreamHandler({
      buffer: { maxBufferSize: 10000, flushIntervalMs: 999999 },
    });
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [{ type: 'text_delta', text: 'Hi' }, { type: 'done' }];

    const result = await handler.processStream(eventsFromArray(events), [adapter]);

    // Only one flush should happen — the forceFlush on done
    const textChunks = captured.chunks.filter((c) => c.protocol.type === 'text_delta');
    expect(textChunks.length).toBe(1);
    expect(textChunks[0].text).toBe('Hi');

    // sendDone should also have been called
    expect(adapter.sendDone).toHaveBeenCalled();
    expect(captured.doneText).toBe('Hi');
    expect(result.totalChunks).toBe(1);
  });
});

describe('ST-03: tool_use event → forceFlush buffer → sendChunk with tool name tag', () => {
  test('sendChunk receives tool label with emoji and tool hint', async () => {
    const handler = new StreamHandler({
      buffer: { maxBufferSize: 10000, flushIntervalMs: 999999 },
    });
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'Analyzing...' },
      { type: 'tool_use', toolName: 'readFile', toolInput: { file_path: '/a.ts' } },
      { type: 'done' },
    ];

    await handler.processStream(eventsFromArray(events), [adapter]);

    // First chunk: forceFlush of buffered text before tool_use
    const textChunks = captured.chunks.filter((c) => c.protocol.type === 'text_delta');
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(textChunks[0].text).toBe('Analyzing...');

    // Second chunk: tool label with protocol type 'tool_start'
    const toolChunks = captured.chunks.filter((c) => c.protocol.type === 'tool_start');
    expect(toolChunks.length).toBe(1);
    expect(toolChunks[0].text).toContain('🔧');
    expect(toolChunks[0].text).toContain('readFile');
    // With file_path hint, format is "> 🔧 readFile：/a.ts"
    expect(toolChunks[0].text).toContain('/a.ts');
  });

  test('tool_use without extractable hint gets generic label', async () => {
    const handler = new StreamHandler({
      buffer: { maxBufferSize: 10000, flushIntervalMs: 999999 },
    });
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [{ type: 'tool_use', toolName: 'myTool' }, { type: 'done' }];

    await handler.processStream(eventsFromArray(events), [adapter]);

    const toolChunks = captured.chunks.filter((c) => c.protocol.type === 'tool_start');
    expect(toolChunks.length).toBe(1);
    // No extractable hint → "调用 myTool ..."
    expect(toolChunks[0].text).toContain('调用 myTool');
  });
});

describe('ST-04: tool_result event → sendChunk "> ✅ 完成"', () => {
  test('adapter.sendChunk receives completion marker', async () => {
    const handler = new StreamHandler();
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [
      { type: 'tool_result', toolName: 'readFile', text: 'file content here' },
      { type: 'done' },
    ];

    await handler.processStream(eventsFromArray(events), [adapter]);

    const resultChunks = captured.chunks.filter((c) => c.protocol.type === 'tool_result');
    expect(resultChunks.length).toBe(1);
    expect(resultChunks[0].text).toBe('> ✅ 完成\n\n');
  });
});

describe('ST-05: error event → adapter.sendError called', () => {
  test('adapter.sendError receives error message', async () => {
    const handler = new StreamHandler();
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'Starting...' },
      { type: 'error', error: 'rate limit exceeded' },
    ];

    await handler.processStream(eventsFromArray(events), [adapter]);

    expect(adapter.sendError).toHaveBeenCalled();
    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].error).toBe('rate limit exceeded');
    expect(captured.errors[0].protocol.type).toBe('error');
  });

  test('error event with no error field sends "Unknown error"', async () => {
    const handler = new StreamHandler();
    const { adapter, captured } = createCapturingAdapter();

    const events: StreamEvent[] = [{ type: 'error' }];

    await handler.processStream(eventsFromArray(events), [adapter]);

    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].error).toBe('Unknown error');
  });
});

describe('ST-06: source throws exception → forceFlush + sendError', () => {
  test('adapter.sendError is called when source async iterator throws', async () => {
    const handler = new StreamHandler({
      buffer: { maxBufferSize: 10000, flushIntervalMs: 999999 },
    });
    const { adapter, captured } = createCapturingAdapter();

    const preEvents: StreamEvent[] = [{ type: 'text_delta', text: 'partial' }];

    const result = await handler.processStream(eventsWithError(preEvents, 'connection reset'), [
      adapter,
    ]);

    // sendError should have been called with the thrown error message
    expect(adapter.sendError).toHaveBeenCalled();
    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].error).toBe('connection reset');

    // fullContent should still contain what was accumulated before the error
    expect(result.fullContent).toBe('partial');
  });
});

describe('ST-07: Multiple adapters → Promise.allSettled concurrent dispatch', () => {
  test('2 adapters both receive sendChunk; one failure does not affect the other', async () => {
    const handler = new StreamHandler({ buffer: { maxBufferSize: 1, flushIntervalMs: 0 } });

    const { adapter: adapter1, captured: cap1 } = createCapturingAdapter('web');

    // Second adapter that throws on second sendChunk call
    const cap2Chunks: string[] = [];
    let adapter2DoneText = '';
    const adapter2: ChannelStreamAdapter = {
      channelType: 'feishu',
      onStreamStart: mock(async () => {}),
      sendChunk: mock(async (text: string) => {
        cap2Chunks.push(text);
        if (cap2Chunks.length === 2) {
          throw new Error('feishu API error');
        }
      }),
      sendDone: mock(async (fullText: string) => {
        adapter2DoneText = fullText;
      }),
      sendError: mock(async () => {}),
    };

    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'A' },
      { type: 'text_delta', text: 'B' },
      { type: 'text_delta', text: 'C' },
      { type: 'done' },
    ];

    const result = await handler.processStream(eventsFromArray(events), [adapter1, adapter2]);

    // adapter1 should have received all text chunks despite adapter2 failure
    const allText1 = cap1.chunks
      .filter((c) => c.protocol.type === 'text_delta')
      .map((c) => c.text)
      .join('');
    expect(allText1).toBe('ABC');

    // adapter2 should have still received some chunks (Promise.allSettled doesn't short-circuit)
    expect(cap2Chunks.length).toBeGreaterThanOrEqual(1);

    // Both adapters should get sendDone (Promise.allSettled)
    expect(adapter1.sendDone).toHaveBeenCalled();
    expect(adapter2.sendDone).toHaveBeenCalled();
    expect(cap1.doneText).toBe('ABC');
    expect(adapter2DoneText).toBe('ABC');
    expect(result.fullContent).toBe('ABC');
  });
});

describe('ST-08: StreamContentFilter filters unknown types, passes known types', () => {
  test('text_delta returns content event; tool_result returns null; unknown returns null', () => {
    const filter = new StreamContentFilter();

    // text_delta → content
    const textResult = filter.filter({ type: 'text_delta', text: 'hello' });
    expect(textResult).not.toBeNull();
    expect(textResult?.type).toBe('content');
    expect(textResult?.text).toBe('hello');
    expect(textResult?.append).toBe(true);

    // tool_use → status
    const toolResult = filter.filter({ type: 'tool_use', toolName: 'Read' });
    expect(toolResult).not.toBeNull();
    expect(toolResult?.type).toBe('status');
    expect(toolResult?.text).toContain('📄'); // Read → "📄 正在读取文件..."

    // tool_result → null (suppressed)
    const resultResult = filter.filter({ type: 'tool_result', toolName: 'Read', text: 'content' });
    expect(resultResult).toBeNull();

    // error → error
    const errorResult = filter.filter({ type: 'error', error: 'boom' });
    expect(errorResult).not.toBeNull();
    expect(errorResult?.type).toBe('error');
    expect(errorResult?.text).toBe('boom');

    // done → done
    const doneResult = filter.filter({ type: 'done' });
    expect(doneResult).not.toBeNull();
    expect(doneResult?.type).toBe('done');
  });

  test('unknown event type returns null (default case)', () => {
    const filter = new StreamContentFilter();

    // Cast to StreamEvent to simulate runtime unknown type
    const unknownEvent = { type: 'thinking', text: 'internal' } as unknown as StreamEvent;
    const result = filter.filter(unknownEvent);
    expect(result).toBeNull();
  });

  test('text_delta with empty text returns null', () => {
    const filter = new StreamContentFilter();
    const result = filter.filter({ type: 'text_delta', text: '' });
    expect(result).toBeNull();
  });

  test('tool_use without toolName returns generic status', () => {
    const filter = new StreamContentFilter();
    const result = filter.filter({ type: 'tool_use' });
    expect(result).not.toBeNull();
    expect(result?.text).toBe('🔧 正在处理...');
  });
});

describe('ST-09: createStreamCallback() → callback/result separation pattern', () => {
  test('callback pushes events; result Promise resolves; fullContent accumulated', async () => {
    const handler = new StreamHandler({ buffer: { maxBufferSize: 1, flushIntervalMs: 0 } });
    const { adapter, captured } = createCapturingAdapter();

    const { callback, result } = handler.createStreamCallback([adapter]);

    // Push events via callback (simulating AgentRuntime behavior)
    callback({ type: 'text_delta', text: 'chunk1' });
    callback({ type: 'text_delta', text: 'chunk2' });
    callback({ type: 'done' });

    // Await the result promise
    const streamResult: StreamResult = await result;

    expect(streamResult.fullContent).toBe('chunk1chunk2');
    expect(streamResult.totalChunks).toBeGreaterThanOrEqual(1);
    expect(streamResult.durationMs).toBeGreaterThanOrEqual(0);

    // Adapter should have received chunks
    expect(captured.started).toBe(true);
    expect(adapter.sendDone).toHaveBeenCalled();
    expect(captured.doneText).toBe('chunk1chunk2');
  });

  test('error event through callback terminates the stream', async () => {
    const handler = new StreamHandler();
    const { adapter, captured } = createCapturingAdapter();

    const { callback, result } = handler.createStreamCallback([adapter]);

    callback({ type: 'text_delta', text: 'partial' });
    callback({ type: 'error', error: 'timeout' });

    const streamResult = await result;

    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].error).toBe('timeout');
    expect(streamResult.fullContent).toBe('partial');
  });
});

// ═══════════════════════════════════════════════════════════════
// ST-10 ~ ST-14: Controller-level integration
// ════��══════════════════════════════════════════════════════════

describe('ST-10: streamResultPromise awaited in executeChatPipeline', () => {
  let ctx: ControllerTestContext;

  afterEach(() => {
    if (ctx) cleanupController(ctx);
  });

  test('after stream completes, pipeline returns with streamed=true', async () => {
    const { adapter, captured } = createCapturingAdapter();

    const agentBridge: AgentBridge = {
      execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'streamed content' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'streamed content',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          toolsUsed: [],
          finishedNaturally: true,
          handledBy: 'claude',
        } satisfies AgentResult;
      }),
    };

    // Skip taskStore (bypasses TaskDispatcher which strips streamed flag)
    // and lightLLM (forces classifier to route to complex/agentBridge path).
    ctx = createTestController({
      agentBridge,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      lightLLM: undefined as any,
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      workspaceManager: createCorrectWorkspaceManager(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      taskStore: undefined as any,
    });

    const result = await ctx.controller.handleIncomingMessage(createMessage());

    // Pipeline should have completed (not hung waiting for stream)
    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    // When going through direct orchestrate path (no TaskDispatcher),
    // the streamed flag is preserved from executeChatPipeline
    expect(result?.data?.streamed).toBe(true);

    // Adapter should have received the full stream
    expect(captured.started).toBe(true);
    expect(captured.doneText).toBe('streamed content');
  });
});

describe('ST-11: Controller filteredCallback → StreamContentFilter suppresses tool_result', () => {
  let ctx: ControllerTestContext;

  afterEach(() => {
    if (ctx) cleanupController(ctx);
  });

  test('tool_result is filtered by StreamContentFilter; adapter does NOT receive ✅ 完成', async () => {
    const { adapter, captured } = createCapturingAdapter();

    const agentBridge: AgentBridge = {
      execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'start' });
          await params.streamCallback({
            type: 'tool_use',
            toolName: 'bash',
            toolInput: { command: 'ls' },
          });
          await params.streamCallback({ type: 'tool_result', toolName: 'bash', text: 'output' });
          await params.streamCallback({ type: 'text_delta', text: 'end' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'startend',
          tokenUsage: { inputTokens: 20, outputTokens: 10 },
          toolsUsed: ['bash'],
          finishedNaturally: true,
          handledBy: 'claude',
        } satisfies AgentResult;
      }),
    };

    ctx = createTestController({
      agentBridge,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      lightLLM: undefined as any,
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      workspaceManager: createCorrectWorkspaceManager(),
    });

    await ctx.controller.handleIncomingMessage(createMessage());

    const allChunkText = captured.chunks.map((c) => c.text).join('');

    // tool_result is filtered by StreamContentFilter → adapter should NOT see "✅ 完成"
    // because the controller wraps the callback with filter.filter() and tool_result → null
    expect(allChunkText).not.toContain('✅ 完成');

    // But tool_use should still pass (filter returns status for tool_use)
    // However, StreamHandler receives tool_use as an original event, producing the 🔧 label
    expect(allChunkText).toContain('🔧');
    expect(allChunkText).toContain('bash');

    // text_delta content should still arrive
    expect(allChunkText).toContain('start');
    expect(allChunkText).toContain('end');
  });
});

describe('ST-12: Feishu CardKit adapter injection path', () => {
  let ctx: ControllerTestContext;

  afterEach(() => {
    if (ctx) cleanupController(ctx);
  });

  test('channel=feishu returns adapter; non-feishu returns empty', async () => {
    const feishuChunks: string[] = [];
    let feishuStarted = false;

    const feishuAdapter: ChannelStreamAdapter = {
      channelType: 'feishu',
      onStreamStart: mock(async () => {
        feishuStarted = true;
      }),
      sendChunk: mock(async (text: string) => {
        feishuChunks.push(text);
      }),
      sendDone: mock(async () => {}),
      sendError: mock(async () => {}),
    };

    const factory = (_userId: string, channel: string, _conversationId: string) => {
      if (channel === 'feishu') {
        return [feishuAdapter];
      }
      return [];
    };

    const agentBridge: AgentBridge = {
      execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'feishu reply' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'feishu reply',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          toolsUsed: [],
          finishedNaturally: true,
          handledBy: 'claude',
        } satisfies AgentResult;
      }),
    };

    // Test 1: Feishu channel → adapter receives events
    ctx = createTestController({
      agentBridge,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      lightLLM: undefined as any,
      streamAdapterFactory: factory,
      workspaceManager: createCorrectWorkspaceManager(),
    });

    await ctx.controller.handleIncomingMessage(
      createMessage({ channel: 'feishu', conversationId: 'chat_feishu_123' }),
    );
    expect(feishuStarted).toBe(true);
    expect(feishuChunks.length).toBeGreaterThanOrEqual(1);

    // Reset for web message
    feishuStarted = false;
    feishuChunks.length = 0;
    cleanupController(ctx);

    // Test 2: Web channel → factory returns [] → no streaming adapters
    ctx = createTestController({
      agentBridge,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      lightLLM: undefined as any,
      streamAdapterFactory: factory,
      workspaceManager: createCorrectWorkspaceManager(),
    });

    const webResult = await ctx.controller.handleIncomingMessage(
      createMessage({ channel: 'web', conversationId: 'conv_web_123' }),
    );

    // feishu adapter should NOT have been invoked for web channel
    expect(feishuStarted).toBe(false);
    // Result should still succeed (just no streaming)
    expect(webResult?.success).toBe(true);
    // streamed should not be set when no adapters
    expect(webResult?.data?.streamed).toBeUndefined();
  });
});

describe('ST-13: CardKit creation failure text degradation', () => {
  test('createStreamingCard throws → sendChunk works → sendDone uses sendTextMessage', async () => {
    const { FeishuStreamAdapter } = await import(
      '../../gateway/channels/adapters/feishu-stream-adapter'
    );

    const sendTextMessageMock = mock(async () => {});
    const deps = {
      createStreamingCard: mock(async () => {
        throw new Error('CardKit API unavailable');
      }),
      sendCardMessage: mock(async () => ''),
      streamUpdateText: mock(async () => {}),
      closeStreamingMode: mock(async () => {}),
      addActionButtons: mock(async () => {}),
      sendTextMessage: sendTextMessageMock,
    };

    const adapter = new FeishuStreamAdapter('chat_123', deps, 0);
    const handler = new StreamHandler({ buffer: { maxBufferSize: 1, flushIntervalMs: 0 } });

    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'Hello from degraded mode' },
      { type: 'done' },
    ];

    const result = await handler.processStream(eventsFromArray(events), [adapter]);

    // Should not have crashed
    expect(result.fullContent).toBe('Hello from degraded mode');

    // In fallback mode, sendDone calls sendTextMessage
    expect(sendTextMessageMock).toHaveBeenCalled();
    const lastCall = sendTextMessageMock.mock.calls[sendTextMessageMock.mock.calls.length - 1];
    expect(lastCall[0]).toBe('chat_123');
    // sendDone receives fullContent as displayText
    expect(lastCall[1]).toBe('Hello from degraded mode');

    // streamUpdateText should NOT have been called (fallback mode skips card updates)
    expect(deps.streamUpdateText).not.toHaveBeenCalled();
  });
});

describe('ST-14: Content > 28k truncation', () => {
  test('accumulated text > 28000 → auto-truncation with "内容已截断" prefix', async () => {
    const { FeishuStreamAdapter } = await import(
      '../../gateway/channels/adapters/feishu-stream-adapter'
    );

    let lastUpdateText = '';
    const deps = {
      createStreamingCard: mock(async () => 'card_id_123'),
      sendCardMessage: mock(async () => 'msg_id_456'),
      streamUpdateText: mock(async (_cardId: string, _elemId: string, text: string) => {
        lastUpdateText = text;
      }),
      closeStreamingMode: mock(async () => {}),
      addActionButtons: mock(async () => {}),
      sendTextMessage: mock(async () => {}),
    };

    const adapter = new FeishuStreamAdapter('chat_123', deps, 0);

    // Simulate onStreamStart to create the card
    await adapter.onStreamStart('test_msg');

    const protocol: StreamProtocol = {
      type: 'text_delta',
      data: { text: '' },
      metadata: { messageId: 'test', sequenceNumber: 1, timestamp: Date.now() },
    };

    // Send a massive chunk that exceeds 28000 chars
    const bigText = 'A'.repeat(29000);
    await adapter.sendChunk(bigText, protocol);

    // streamUpdateText should have been called with truncated content
    expect(deps.streamUpdateText).toHaveBeenCalled();
    expect(lastUpdateText).toContain('内容已截断');
    // Truncated content should be shorter than original
    expect(lastUpdateText.length).toBeLessThan(29000);
    // Should still contain the tail of the original content
    expect(lastUpdateText).toContain('AAA');
  });

  test('truncation keeps last (MAX - 100) chars with prefix', async () => {
    const { FeishuStreamAdapter } = await import(
      '../../gateway/channels/adapters/feishu-stream-adapter'
    );

    let lastUpdateText = '';
    const deps = {
      createStreamingCard: mock(async () => 'card_id_123'),
      sendCardMessage: mock(async () => 'msg_id_456'),
      streamUpdateText: mock(async (_cardId: string, _elemId: string, text: string) => {
        lastUpdateText = text;
      }),
      closeStreamingMode: mock(async () => {}),
      addActionButtons: mock(async () => {}),
      sendTextMessage: mock(async () => {}),
    };

    const adapter = new FeishuStreamAdapter('chat_123', deps, 0);
    await adapter.onStreamStart('test_msg');

    const protocol: StreamProtocol = {
      type: 'text_delta',
      data: { text: '' },
      metadata: { messageId: 'test', sequenceNumber: 1, timestamp: Date.now() },
    };

    // MAX_CARD_CONTENT_LENGTH = 28000, keep = 28000 - 100 = 27900
    const overflowText = 'X'.repeat(28001);
    await adapter.sendChunk(overflowText, protocol);

    // After truncation: "... (内容已截断)\n\n" + last 27900 chars
    expect(lastUpdateText).toContain('内容已截断');
    const xCount = (lastUpdateText.match(/X/g) || []).length;
    expect(xCount).toBe(27900);
  });
});

// ═══════════════════════════════════════════════════════════════
// ST-15: Gateway quick path must push stream events to avoid deadlock
// ═══════════════════════════════════════════════════════════════

describe('ST-15: Gateway quick path pushes text_delta+done to stream callback (deadlock fix)', () => {
  let ctx: ControllerTestContext;

  afterEach(() => {
    if (ctx) cleanupController(ctx);
  });

  test('simple message via IntelligenceGateway completes without hanging', async () => {
    const { adapter, captured } = createCapturingAdapter();

    // LightLLM mock: gateway will handle directly (simple + chat + no attachments)
    const lightLLM = createMockLightLLM('快速回复');

    // agentBridge should NOT be called for simple gateway tasks
    const agentBridge: AgentBridge = {
      execute: mock(async () => {
        throw new Error('Should not reach agentBridge for simple tasks');
      }),
    };

    ctx = createTestController({
      agentBridge,
      lightLLM,
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      workspaceManager: createCorrectWorkspaceManager(),
      // No taskStore → bypass TaskDispatcher, go through direct orchestrate path
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      taskStore: undefined as any,
    });

    // Race: if the fix is missing, this will hang forever (deadlock)
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    const resultPromise = ctx.controller.handleIncomingMessage(createMessage({ content: '你好' }));
    const result = await Promise.race([resultPromise, timeout]);

    // Should NOT have timed out
    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);

    // Stream adapter should have received the gateway response via pushed events
    expect(captured.started).toBe(true);
    expect(captured.doneText).toBe('快速回复');
  });
});
