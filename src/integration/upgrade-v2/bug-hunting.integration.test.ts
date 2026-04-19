/**
 * Bug-hunting integration tests — designed to BREAK things.
 *
 * These tests deliberately create failure conditions to find bugs
 * that happy-path tests miss.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { AgentBridge, AgentExecuteParams } from '../../kernel/agents/agent-bridge';
import { AgentBridgeWithFallback } from '../../kernel/agents/agent-bridge-fallback';
import type { CentralControllerDeps } from '../../kernel/central-controller';
import type { ChannelStreamAdapter } from '../../kernel/streaming/stream-protocol';
import {
  type ControllerTestContext,
  cleanupController,
  createMessage,
  createMockLightLLM,
  createTestController,
} from './test-helpers';

const MOCK_WORKSPACE = '/tmp/test-workspace';
const USER_CONFIG_DIR = path.join(MOCK_WORKSPACE, 'memory');

function createCapturingAdapter() {
  const captured = {
    started: false,
    chunks: [] as string[],
    doneText: '',
    doneCalled: false,
    errors: [] as string[],
  };
  const adapter: ChannelStreamAdapter = {
    onStreamStart: mock(async () => {
      captured.started = true;
    }),
    sendChunk: mock(async (text: string) => {
      captured.chunks.push(text);
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

function createPipelineTestController(
  overrides?: Partial<CentralControllerDeps>,
): ControllerTestContext {
  return createTestController({ taskStore: undefined, ...overrides });
}

let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
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
// BUG-HUNT-01: Gateway fails + AgentRuntime fails → card stuck in loading
// ════════════════════════════════════════════════════════════════

describe('BUG-HUNT-01: Both gateway and runtime fail → stream adapter must still close', () => {
  let ctx: ControllerTestContext;
  afterEach(() => ctx && cleanupController(ctx));

  test('sendDone must be called even when all execution paths throw', async () => {
    // LightLLM that always throws → gateway fails
    const lightLLM = {
      complete: mock(async () => {
        throw new Error('LightLLM 500');
      }),
      stream: mock(async function* () {
        throw new Error('LightLLM 500');
      }),
      getDefaultModel: () => 'mock',
    } as unknown as CentralControllerDeps['lightLLM'];

    // AgentBridge that always throws → runtime fallback also fails
    const agentBridge: AgentBridge = {
      execute: mock(async () => {
        throw new Error('Bridge also dead');
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge,
      lightLLM,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'hello' });

    let threw = false;
    try {
      await ctx.controller.handleIncomingMessage(msg);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true); // Should throw

    // THE BUG: if onStreamStart was called but sendDone was NOT called,
    // the Feishu card is stuck in streaming mode forever
    if (captured.started) {
      expect(captured.doneCalled).toBe(true); // Will this pass?
    }
  });
});

// ════════════════════════════════════════════════════════════════
// BUG-HUNT-02: Primary bridge partially streams then crashes →
//              fallback streams → user sees garbled content
// ════════════════════════════════════════════════════════════════

describe('BUG-HUNT-02: Primary bridge partial stream + crash → fallback should not produce garbled content', () => {
  let ctx: ControllerTestContext;
  afterEach(() => ctx && cleanupController(ctx));

  test('stream adapter should NOT contain mixed content from both bridges', async () => {
    // Primary bridge: streams partial content then crashes
    const primaryBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams) => {
        // Stream some content before crashing
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'PARTIAL_FROM_PRIMARY_' });
        }
        // Crash without sending done
        throw new Error('exited with code 1: primary crashed mid-stream');
      }),
    };

    // Fallback bridge: works correctly
    const fallbackBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams) => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'CLEAN_FALLBACK_RESPONSE' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'CLEAN_FALLBACK_RESPONSE',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const bridge = new AgentBridgeWithFallback(primaryBridge, fallbackBridge, 'codex', 'claude');
    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge: bridge,
      lightLLM: undefined, // force complex path
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'hello' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);

    // THE BUG: doneText contains BOTH "PARTIAL_FROM_PRIMARY_" AND "CLEAN_FALLBACK_RESPONSE"
    // User sees garbled: "PARTIAL_FROM_PRIMARY_CLEAN_FALLBACK_RESPONSE"
    const hasPartialPrimary = captured.doneText.includes('PARTIAL_FROM_PRIMARY_');
    const hasFallback = captured.doneText.includes('CLEAN_FALLBACK_RESPONSE');

    // Ideally: only fallback content should appear. Primary partial should be discarded.
    if (hasPartialPrimary && hasFallback) {
      // This is the bug — mixed content from both bridges
      console.error('[BUG CONFIRMED] Stream contains mixed content:', captured.doneText);
    }

    // Assert what SHOULD happen (will fail if bug exists):
    expect(captured.doneText).not.toContain('PARTIAL_FROM_PRIMARY_');
    expect(captured.doneText).toBe('CLEAN_FALLBACK_RESPONSE');
  });
});

// ════════════════════════════════════════════════════════════════
// BUG-HUNT-03: Bridge returns empty content → card shows empty
// ════════════════════════════════════════════════════════════════

describe('BUG-HUNT-03: Bridge returns empty content → response should not be empty', () => {
  let ctx: ControllerTestContext;
  afterEach(() => ctx && cleanupController(ctx));

  test('empty bridge response should be handled gracefully', async () => {
    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams) => {
        if (params.streamCallback) {
          // Send done without any content
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: '',
          tokenUsage: { inputTokens: 10, outputTokens: 0 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge,
      lightLLM: undefined,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'hello' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    // Result succeeds but content is empty
    expect(result.success).toBe(true);
    const data = result.data as { content: string };

    // THE BUG: empty content goes all the way to the card
    // User sees "（无响应内容）"
    console.error('[BUG-HUNT-03] result.data.content:', JSON.stringify(data.content));
    console.error('[BUG-HUNT-03] captured.doneText:', JSON.stringify(captured.doneText));

    // This documents the behavior — empty content is passed through
    expect(data.content).toBe(''); // Confirms empty content reaches user
  });
});

// ════════════════════════════════════════════════════════════════
// BUG-HUNT-04: LightLLM returns empty string → gateway returns empty
// ════════════════════════════════════════════════════════════════

describe('BUG-HUNT-04: LightLLM returns empty content → user gets empty card', () => {
  let ctx: ControllerTestContext;
  afterEach(() => ctx && cleanupController(ctx));

  test('empty LightLLM response on quick path', async () => {
    const lightLLM = createMockLightLLM('');
    const agentBridge: AgentBridge = {
      execute: mock(async () => ({
        content: 'should not reach here',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        finishedNaturally: true,
        handledBy: 'claude' as const,
      })),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge,
      lightLLM,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    const data = result.data as { content: string };
    console.error('[BUG-HUNT-04] LightLLM empty → result.content:', JSON.stringify(data.content));
    console.error('[BUG-HUNT-04] captured.doneText:', JSON.stringify(captured.doneText));

    // Empty LightLLM response — does it get passed through or trigger safety valve?
    // isSafetyValveTrigger checks for specific phrases, empty string does NOT match
    // So empty response is returned to user as-is
    expect(data.content).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// BUG-HUNT-05: Concurrent messages same session — race condition
// ════════════════════════════════════════════════════════════════

describe('BUG-HUNT-05: Concurrent messages in same session', () => {
  let ctx: ControllerTestContext;
  afterEach(() => ctx && cleanupController(ctx));

  test('parallel messages should not corrupt session state', async () => {
    let callCount = 0;
    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams) => {
        callCount++;
        const myCount = callCount;
        // Simulate processing time
        await new Promise((r) => setTimeout(r, 50));
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: `Response_${myCount}` });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: `Response_${myCount}`,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude' as const,
        };
      }),
    };

    ctx = createPipelineTestController({
      agentBridge,
      lightLLM: undefined,
    });

    const msg1 = createMessage({
      content: 'first',
      userId: 'user_race',
      conversationId: 'conv_race',
    });
    const msg2 = createMessage({
      content: 'second',
      userId: 'user_race',
      conversationId: 'conv_race',
    });

    // Fire both concurrently
    const [r1, r2] = await Promise.all([
      ctx.controller.handleIncomingMessage(msg1),
      ctx.controller.handleIncomingMessage(msg2),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Both should complete without crash
    const d1 = r1.data as { content: string };
    const d2 = r2.data as { content: string };

    console.error('[BUG-HUNT-05] msg1 result:', d1.content);
    console.error('[BUG-HUNT-05] msg2 result:', d2.content);

    // Each should have distinct content (serializer should prevent interleaving)
    expect(d1.content).not.toBe(d2.content);
  });
});
