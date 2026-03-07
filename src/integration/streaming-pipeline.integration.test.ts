/**
 * 集成测试: 流式响应管道
 *
 * 测试 StreamHandler + ChannelStreamAdapter 端到端:
 *   AgentRuntime.streamCallback → StreamHandler.createStreamCallback → adapters → 客户端
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { AgentRuntime } from '../kernel/agents/agent-runtime';
import type { AgentBridgeResult, ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { SessionManager } from '../kernel/sessioning/session-manager';
import type { ChannelStreamAdapter, StreamProtocol } from '../kernel/streaming/stream-protocol';
import type { BotMessage } from '../shared/messaging';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

// ── Helpers ───────────────────────────────────────────────

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}`,
    channel: 'web',
    userId: 'user_stream',
    userName: 'Stream Tester',
    conversationId: 'conv_stream',
    content: '帮我写代码',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function createStreamingClaudeBridge(chunks: string[]): ClaudeAgentBridge {
  return {
    execute: mock(async (params: { onStream?: (e: StreamEvent) => void }) => {
      if (params.onStream) {
        for (const chunk of chunks) {
          params.onStream({ type: 'text_delta', text: chunk });
        }
        params.onStream({ type: 'done' });
      }
      return {
        content: chunks.join(''),
        toolsUsed: [],
        turns: 1,
        usage: { inputTokens: 10, outputTokens: chunks.length * 3, costUsd: 0.001 },
      } satisfies AgentBridgeResult;
    }),
    estimateCost: () => 0.001,
    getActiveSessions: () => 0,
  } as unknown as ClaudeAgentBridge;
}

/** Captures all calls to a mock ChannelStreamAdapter */
function createCapturingAdapter(channelType = 'web') {
  const captured = {
    started: false,
    chunks: [] as string[],
    protocols: [] as StreamProtocol[],
    doneText: '',
    error: '',
  };
  const adapter: ChannelStreamAdapter = {
    channelType,
    onStreamStart: mock(async () => {
      captured.started = true;
    }),
    sendChunk: mock(async (text: string, protocol?: StreamProtocol) => {
      captured.chunks.push(text);
      if (protocol) captured.protocols.push(protocol);
    }),
    sendDone: mock(async (fullText: string) => {
      captured.doneText = fullText;
    }),
    sendError: mock(async (error: string) => {
      captured.error = error;
    }),
  };
  return { adapter, captured };
}

// ── Tests ─────────────────────────────────────────────────

describe('流式管道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    CentralController.resetInstance();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('流式事件应该通过 streamAdapterFactory 传递到 adapter', async () => {
    const chunks = ['Hello', ' ', 'World'];
    const claudeBridge = createStreamingClaudeBridge(chunks);
    const { adapter, captured } = createCapturingAdapter();

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      ...createMockOVDeps(),
    });

    await controller.handleIncomingMessage(createMessage());

    expect(captured.started).toBe(true);
    expect(captured.doneText).toBe('Hello World');
    // Should have received at least some text chunks
    expect(captured.chunks.length).toBeGreaterThanOrEqual(1);
    expect(captured.chunks.join('')).toBe('Hello World');
  });

  test('多个 adapter 应该同时收到流式事件', async () => {
    const chunks = ['A', 'B'];
    const claudeBridge = createStreamingClaudeBridge(chunks);
    const { adapter: adapter1, captured: cap1 } = createCapturingAdapter('web');
    const { adapter: adapter2, captured: cap2 } = createCapturingAdapter('feishu');

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      streamAdapterFactory: (_u, _c, _conv) => [adapter1, adapter2],
      ...createMockOVDeps(),
    });

    await controller.handleIncomingMessage(createMessage());

    expect(cap1.started).toBe(true);
    expect(cap2.started).toBe(true);
    expect(cap1.doneText).toBe('AB');
    expect(cap2.doneText).toBe('AB');
  });

  test('流式含 tool_use 事件应该传递工具调用信息', async () => {
    const claudeBridge = {
      execute: mock(async (params: { onStream?: (e: StreamEvent) => void }) => {
        if (params.onStream) {
          params.onStream({ type: 'text_delta', text: '分析中...' });
          params.onStream({ type: 'tool_use', toolName: 'readFile', toolInput: { path: '/a.ts' } });
          params.onStream({ type: 'tool_result', toolName: 'readFile', text: 'file content' });
          params.onStream({ type: 'text_delta', text: '结果如下' });
          params.onStream({ type: 'done' });
        }
        return {
          content: '分析中...结果如下',
          toolsUsed: ['readFile'],
          turns: 1,
          usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.002 },
        } satisfies AgentBridgeResult;
      }),
      estimateCost: () => 0.002,
      getActiveSessions: () => 0,
    } as unknown as ClaudeAgentBridge;

    const { adapter, captured } = createCapturingAdapter();

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      ...createMockOVDeps(),
    });

    await controller.handleIncomingMessage(createMessage());

    expect(captured.started).toBe(true);
    // Should have received tool-related chunks
    const allChunks = captured.chunks.join('');
    expect(allChunks).toContain('readFile');
    expect(captured.doneText).toContain('分析中...');
  });

  test('流式错误事件应该通过 sendError 传递给 adapter', async () => {
    const claudeBridge = {
      execute: mock(async (params: { onStream?: (e: StreamEvent) => void }) => {
        if (params.onStream) {
          params.onStream({ type: 'text_delta', text: '开始' });
          params.onStream({ type: 'error', error: 'rate limit exceeded' });
        }
        return {
          content: '开始',
          toolsUsed: [],
          turns: 1,
          usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.0005 },
        } satisfies AgentBridgeResult;
      }),
      estimateCost: () => 0.0005,
      getActiveSessions: () => 0,
    } as unknown as ClaudeAgentBridge;

    const { adapter, captured } = createCapturingAdapter();

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      ...createMockOVDeps(),
    });

    await controller.handleIncomingMessage(createMessage());

    expect(captured.error).toBe('rate limit exceeded');
  });

  test('无 streamAdapterFactory 时应该回退到 streamCallback', async () => {
    const chunks = ['X', 'Y'];
    const claudeBridge = createStreamingClaudeBridge(chunks);
    const callbackEvents: StreamEvent[] = [];

    const controller = CentralController.getInstance({
      claudeBridge,
      classifier: new TaskClassifier(null),
      streamCallback: (_userId, event) => {
        callbackEvents.push(event);
      },
      ...createMockOVDeps(),
    });

    await controller.handleIncomingMessage(createMessage());

    expect(callbackEvents.some((e) => e.type === 'text_delta')).toBe(true);
    expect(callbackEvents[callbackEvents.length - 1].type).toBe('done');
  });

  test('会话上下文应该传递给 Claude Bridge', async () => {
    const sessionManager = new SessionManager();
    let receivedMessages: Array<{ role: string; content: string }> = [];

    const claudeBridge = {
      execute: mock(async (params: { messages: Array<{ role: string; content: string }> }) => {
        receivedMessages = params.messages;
        return {
          content: 'reply',
          toolsUsed: [],
          turns: 1,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        } satisfies AgentBridgeResult;
      }),
      estimateCost: () => 0.001,
      getActiveSessions: () => 0,
    } as unknown as ClaudeAgentBridge;

    const agentRuntime = new AgentRuntime({
      claudeBridge,
      classifier: new TaskClassifier(null),
    });

    const controller = CentralController.getInstance({
      sessionManager,
      agentRuntime,
      ...createMockOVDeps(),
    });

    // First message
    await controller.handleIncomingMessage(createMessage({ content: '第一条' }));
    // Second message — should include history
    await controller.handleIncomingMessage(createMessage({ content: '第二条' }));

    // The second call should have received the full conversation history
    expect(receivedMessages.length).toBe(3); // user1 + assistant1 + user2
    expect(receivedMessages[0].role).toBe('user');
    expect(receivedMessages[0].content).toBe('第一条');
    expect(receivedMessages[1].role).toBe('assistant');
    expect(receivedMessages[1].content).toBe('reply');
    expect(receivedMessages[2].role).toBe('user');
    expect(receivedMessages[2].content).toBe('第二条');
  });
});
