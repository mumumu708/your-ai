/**
 * Main Pipeline E2E Integration Tests (E2E-01 ~ E2E-07)
 *
 * Tests the FULL message pipeline from CentralController.handleIncomingMessage()
 * entry point through to stream adapter output, covering all real user-facing scenarios.
 *
 * Real: CentralController, IntelligenceGateway, AgentBridgeWithFallback, StreamHandler.
 * Mock: LightLLM, AgentBridge, MediaProcessor.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentBridge,
  AgentExecuteParams,
  AgentResult,
} from '../../kernel/agents/agent-bridge';
import { AgentBridgeWithFallback } from '../../kernel/agents/agent-bridge-fallback';
import type { CentralControllerDeps } from '../../kernel/central-controller';
import type { ChannelStreamAdapter } from '../../kernel/streaming/stream-protocol';
import {
  type ControllerTestContext,
  cleanupController,
  createMessage,
  createMockAgentBridge,
  createMockLightLLM,
  createTestController,
} from './test-helpers';

// ── Constants ────────────────────────────────────────────────

const MOCK_WORKSPACE = '/tmp/test-workspace';
const USER_CONFIG_DIR = path.join(MOCK_WORKSPACE, 'memory');

// ── Capturing Stream Adapter ─────────────────────────────────

function createCapturingAdapter(): {
  adapter: ChannelStreamAdapter;
  captured: {
    started: boolean;
    chunks: Array<{ text: string }>;
    doneText: string;
    doneCalled: boolean;
    errors: string[];
  };
} {
  const captured = {
    started: false,
    chunks: [] as Array<{ text: string }>,
    doneText: '',
    doneCalled: false,
    errors: [] as string[],
  };

  const adapter = {
    onStreamStart: mock(async () => {
      captured.started = true;
    }),
    sendChunk: mock(async (text: string) => {
      captured.chunks.push({ text });
    }),
    sendDone: mock(async (fullText: string) => {
      captured.doneText = fullText;
      captured.doneCalled = true;
    }),
    sendError: mock(async (error: string) => {
      captured.errors.push(error);
    }),
  };

  return { adapter, captured };
}

// ── Pipeline Controller Factory ──────────────────────────────

function createPipelineTestController(
  overrides?: Partial<CentralControllerDeps>,
): ControllerTestContext {
  return createTestController({
    taskStore: undefined,
    ...overrides,
  });
}

// ── Global spies ─────────────────────────────────────────────

let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Bypass onboarding: UserConfigLoader.hasUserConfig('SOUL.md') checks filesystem
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'SOUL.md'), '# Soul\nBe helpful.');
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'IDENTITY.md'), '# Identity\nTest Agent.');
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'AGENTS.md'), '# Agents\nCore protocol.');

  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ════════════════════════════════════════════════════════════════
// E2E-01: Simple message → LightLLM direct reply
// ════════════════════════════════════════════════════════════════

describe('E2E-01: Simple message → LightLLM direct reply via gateway', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('gateway canHandleDirectly=true → quickAnswer → card shows LightLLM content', async () => {
    const llmResponse = '你好！有什么可以帮你的？';
    const lightLLM = createMockLightLLM(llmResponse);
    const agentBridge = createMockAgentBridge('should not be called');
    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      lightLLM,
      agentBridge,
      streamAdapterFactory: () => [adapter],
    });

    // Pure simple chat — no tool indicators, no memory indicators
    const msg = createMessage({ content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string; channel?: string; complexity?: string };
    expect(data.content).toBe(llmResponse);
    // Gateway handled it → channel=light_llm
    expect(data.channel).toBe('light_llm');
    expect(data.complexity).toBe('simple');
    // agentBridge should NOT have been called
    expect(agentBridge.execute).not.toHaveBeenCalled();
    // Stream adapter received the content
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe(llmResponse);
  });
});

// ════════════════════════════════════════════════════════════════
// E2E-02: Simple message → safety valve → Agent Bridge
// ════════════════════════════════════════════════════════════════

describe('E2E-02: LightLLM returns safety phrase → gateway escalates to agentBridge', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('safety phrase triggers escalation, agentBridge response shown instead', async () => {
    const SAFETY_PHRASE = '我需要更仔细地处理这个问题';
    const BRIDGE_RESPONSE = '深度分析结果';

    // LightLLM always returns safety phrase (classifier uses rule-based for simple chat,
    // so the safety phrase will be the quickAnswer response)
    const lightLLM = createMockLightLLM(SAFETY_PHRASE);

    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: BRIDGE_RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: BRIDGE_RESPONSE,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      lightLLM,
      agentBridge,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    // Content must NOT be the safety phrase
    expect(data.content).not.toBe(SAFETY_PHRASE);
    expect(data.content).toBe(BRIDGE_RESPONSE);
    // agentBridge was called (escalation happened)
    expect(agentBridge.execute).toHaveBeenCalled();
    // Stream adapter received the bridge content
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe(BRIDGE_RESPONSE);
  });
});

// ════════════════════════════════════════════════════════════════
// E2E-03: Complex message → Agent Bridge direct
// ════════════════════════════════════════════════════════════════

describe('E2E-03: Complex message → Agent Bridge direct (skips gateway quickAnswer)', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('message with tool indicators bypasses gateway quickAnswer → agentBridge called', async () => {
    const BRIDGE_RESPONSE = '代码分析完成，以下是结果...';

    const lightLLM = createMockLightLLM('should not reach quickAnswer');
    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: BRIDGE_RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: BRIDGE_RESPONSE,
          tokenUsage: { inputTokens: 20, outputTokens: 10 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      lightLLM,
      agentBridge,
      streamAdapterFactory: () => [adapter],
    });

    // "帮我" triggers mightNeedTools → canHandleDirectly=false → goes to agentBridge
    const msg = createMessage({ content: '帮我分析一下代码' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe(BRIDGE_RESPONSE);
    expect(agentBridge.execute).toHaveBeenCalled();
    // Stream adapter received content from bridge
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe(BRIDGE_RESPONSE);
  });
});

// ════════════════════════════════════════════════════════════════
// E2E-04: Primary bridge fails → Fallback bridge
// ════════════════════════════════════════════════════════════════

describe('E2E-04: Primary bridge fails → AgentBridgeWithFallback triggers fallback', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('primary throws "exited with code 1" → fallback bridge responds', async () => {
    const FALLBACK_RESPONSE = '备用 Agent 的回复';

    const primaryBridge: AgentBridge = {
      execute: mock(async (): Promise<AgentResult> => {
        throw new Error('process exited with code 1: command failed');
      }),
    };

    const fallbackBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: FALLBACK_RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: FALLBACK_RESPONSE,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    // REAL AgentBridgeWithFallback wrapping two mock bridges
    const bridge = new AgentBridgeWithFallback(primaryBridge, fallbackBridge, 'codex', 'claude');

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge: bridge,
      lightLLM: undefined, // no gateway → goes straight to agentRuntime → bridge
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: '测试主备切换' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe(FALLBACK_RESPONSE);
    expect(primaryBridge.execute).toHaveBeenCalled();
    expect(fallbackBridge.execute).toHaveBeenCalled();
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe(FALLBACK_RESPONSE);
  });
});

// ════════════════════════════════════════════════════════════════
// E2E-05: LightLLM 429 → fallback to Agent Bridge
// ════════════════════════════════════════════════════════════════

describe('E2E-05: LightLLM 429 → gateway catch → AgentRuntime forceComplex', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('LightLLM throws 429 → gateway error caught → agentBridge responds', async () => {
    const BRIDGE_RESPONSE = '通过 Agent 处理的回复';

    // LightLLM throws 429 on every call (gateway quickAnswer attempt)
    const lightLLM = {
      complete: mock(async () => {
        throw new Error('429 rate limit exceeded');
      }),
      stream: mock(async function* () {
        yield { content: '', done: true };
      }),
      getDefaultModel: () => 'mock-model',
    } as unknown as CentralControllerDeps['lightLLM'];

    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: BRIDGE_RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: BRIDGE_RESPONSE,
          tokenUsage: { inputTokens: 15, outputTokens: 8 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      lightLLM,
      agentBridge,
      streamAdapterFactory: () => [adapter],
    });

    // Simple chat → gateway attempts quickAnswer → throws 429 → catch → forceComplex
    const msg = createMessage({ content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe(BRIDGE_RESPONSE);
    expect(agentBridge.execute).toHaveBeenCalled();
    expect(captured.doneCalled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// E2E-06: Message with attachments → bypasses gateway
// ════════════════════════════════════════════════════════════════

describe('E2E-06: Message with attachments → canHandleDirectly=false → agentBridge', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('attachment presence bypasses gateway, mediaProcessor called, agentBridge handles', async () => {
    const BRIDGE_RESPONSE = '已分析图片内容';
    const lightLLM = createMockLightLLM('should not be called for quick answer');
    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: BRIDGE_RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: BRIDGE_RESPONSE,
          tokenUsage: { inputTokens: 20, outputTokens: 10 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const mediaProcessor = {
      processAttachments: mock(async () => [
        {
          id: 'att1',
          mediaType: 'image',
          state: 'processed',
          mimeType: 'image/png',
          description: '一张测试图片',
          base64Data: 'abc123',
        },
      ]),
      toMediaRef: mock((a: { description?: string }) => ({
        mediaType: 'image' as const,
        mimeType: 'image/png',
        description: a.description ?? '[图片]',
        base64Data: 'abc123',
      })),
    };

    ctx = createPipelineTestController({
      lightLLM,
      agentBridge,
      mediaProcessor: mediaProcessor as unknown as CentralControllerDeps['mediaProcessor'],
    });

    const msg = createMessage({
      content: '分析这张图片',
      attachments: [
        {
          id: 'att1',
          mediaType: 'image' as const,
          state: 'pending' as const,
          mimeType: 'image/png',
          sourceRef: { channel: 'web' as const, base64: 'abc123' },
        },
      ],
    });

    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe(BRIDGE_RESPONSE);
    // agentBridge must be called (attachments bypass gateway)
    expect(agentBridge.execute).toHaveBeenCalled();
    // mediaProcessor.processAttachments must be called
    expect(mediaProcessor.processAttachments).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════
// E2E-07: Multi-turn conversation (session reuse)
// ════════════════════════════════════════════════════════════════

describe('E2E-07: Multi-turn conversation — claudeSessionId reused on second message', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('second message receives claudeSessionId from first call result', async () => {
    const SESSION_ID = 'claude-session-abc123';
    const capturedParams: AgentExecuteParams[] = [];

    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        capturedParams.push({ ...params });
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: '回复内容' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: '回复内容',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
          // First call returns a claudeSessionId; second call preserves it
          claudeSessionId: SESSION_ID,
        };
      }),
    };

    ctx = createPipelineTestController({
      agentBridge,
      lightLLM: undefined, // no gateway, goes directly to agentBridge
    });

    const userId = 'user_e2e07';
    const conversationId = 'conv_e2e07';

    // First message
    const msg1 = createMessage({
      content: '第一条消息',
      userId,
      conversationId,
    });
    const result1 = await ctx.controller.handleIncomingMessage(msg1);
    expect(result1.success).toBe(true);

    // First call should have no claudeSessionId (new session)
    expect(capturedParams[0]?.claudeSessionId).toBeUndefined();

    // Second message — same userId + conversationId → session reuse
    const msg2 = createMessage({
      content: '第二条消息',
      userId,
      conversationId,
    });
    const result2 = await ctx.controller.handleIncomingMessage(msg2);
    expect(result2.success).toBe(true);

    // Second call must have received the claudeSessionId from the first result
    expect(capturedParams[1]?.claudeSessionId).toBe(SESSION_ID);
    // agentBridge called twice
    expect(agentBridge.execute).toHaveBeenCalledTimes(2);
  });
});
