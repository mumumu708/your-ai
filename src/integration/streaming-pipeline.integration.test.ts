/**
 * 集成测试: 流式响应管道
 *
 * 测试 StreamHandler + ChannelStreamAdapter 端到端:
 *   AgentRuntime.streamCallback → StreamHandler.createStreamCallback → adapters → 客户端
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBridge, AgentResult } from '../kernel/agents/agent-bridge';
import { AgentRuntime } from '../kernel/agents/agent-runtime';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { SessionManager } from '../kernel/sessioning/session-manager';
import type { ChannelStreamAdapter, StreamProtocol } from '../kernel/streaming/stream-protocol';
import type { BotMessage } from '../shared/messaging';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

const TEST_USER_SPACE = join(tmpdir(), 'your-ai-test-stream');

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

function createStreamingAgentBridge(chunks: string[]): AgentBridge {
  return {
    execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
      if (params.streamCallback) {
        for (const chunk of chunks) {
          await params.streamCallback({ type: 'text_delta', text: chunk });
        }
        await params.streamCallback({ type: 'done' });
      }
      return {
        content: chunks.join(''),
        tokenUsage: { inputTokens: 10, outputTokens: chunks.length * 3 },
        toolsUsed: [],
        finishedNaturally: true,
        handledBy: 'claude',
      } satisfies AgentResult;
    }),
  };
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
    process.env.USER_SPACE_ROOT = TEST_USER_SPACE;
    // Ensure SOUL.md exists so onboarding is skipped
    const memDir = join(TEST_USER_SPACE, 'user_stream', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'SOUL.md'), 'Test Agent', 'utf-8');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    CentralController.resetInstance();
    process.env.USER_SPACE_ROOT = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('流式事件应该通过 streamAdapterFactory 传递到 adapter', async () => {
    const chunks = ['Hello', ' ', 'World'];
    const agentBridge = createStreamingAgentBridge(chunks);
    const { adapter, captured } = createCapturingAdapter();

    const controller = CentralController.getInstance({
      agentBridge,
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
    const agentBridge = createStreamingAgentBridge(chunks);
    const { adapter: adapter1, captured: cap1 } = createCapturingAdapter('web');
    const { adapter: adapter2, captured: cap2 } = createCapturingAdapter('feishu');

    const controller = CentralController.getInstance({
      agentBridge,
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
    const agentBridge: AgentBridge = {
      execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: '分析中...' });
          await params.streamCallback({
            type: 'tool_use',
            toolName: 'readFile',
            toolInput: { path: '/a.ts' },
          });
          await params.streamCallback({
            type: 'tool_result',
            toolName: 'readFile',
            text: 'file content',
          });
          await params.streamCallback({ type: 'text_delta', text: '结果如下' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: '分析中...结果如下',
          tokenUsage: { inputTokens: 20, outputTokens: 10 },
          toolsUsed: ['readFile'],
          finishedNaturally: true,
          handledBy: 'claude',
        } satisfies AgentResult;
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    const controller = CentralController.getInstance({
      agentBridge,
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
    const agentBridge: AgentBridge = {
      execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: '开始' });
          await params.streamCallback({ type: 'error', error: 'rate limit exceeded' });
        }
        return {
          content: '开始',
          tokenUsage: { inputTokens: 5, outputTokens: 2 },
          toolsUsed: [],
          finishedNaturally: true,
          handledBy: 'claude',
        } satisfies AgentResult;
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    const controller = CentralController.getInstance({
      agentBridge,
      classifier: new TaskClassifier(null),
      streamAdapterFactory: (_u, _c, _conv) => [adapter],
      ...createMockOVDeps(),
    });

    await controller.handleIncomingMessage(createMessage());

    expect(captured.error).toBe('rate limit exceeded');
  });

  test('无 streamAdapterFactory 时应该回退到 streamCallback', async () => {
    const chunks = ['X', 'Y'];
    const agentBridge = createStreamingAgentBridge(chunks);
    const callbackEvents: StreamEvent[] = [];

    const controller = CentralController.getInstance({
      agentBridge,
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
    const receivedUserMessages: string[] = [];

    const agentBridge: AgentBridge = {
      execute: mock(async (params: { userMessage: string }) => {
        receivedUserMessages.push(params.userMessage);
        return {
          content: 'reply',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          toolsUsed: [],
          finishedNaturally: true,
          handledBy: 'claude',
        } satisfies AgentResult;
      }),
    };

    const agentRuntime = new AgentRuntime({
      agentBridge,
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

    // AgentBridge should have been called twice, each time with the user's message
    expect(receivedUserMessages).toHaveLength(2);
    expect(receivedUserMessages[0]).toBe('第一条');
    expect(receivedUserMessages[1]).toBe('第二条');
  });
});
