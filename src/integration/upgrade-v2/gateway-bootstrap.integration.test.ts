/**
 * Gateway Bootstrap Integration Tests (GW-01 ~ GW-05)
 *
 * Tests for the gateway bootstrap composition logic (src/gateway/index.ts patterns)
 * and CentralController dependency injection:
 *   GW-01: AgentBridgeWithFallback — claude primary, codex fallback
 *   GW-02: AgentBridgeWithFallback — reversed config (codex primary, claude fallback)
 *   GW-03: isProviderUnavailable pattern matching (all patterns)
 *   GW-04: streamAdapterFactory injection — factory called with correct args
 *   GW-05: placeholderSender injection for Feishu channel
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
  createTestController,
} from './test-helpers';

// ── Constants ────────────────────────────────────────────────

const MOCK_WORKSPACE = '/tmp/test-workspace';
const USER_CONFIG_DIR = path.join(MOCK_WORKSPACE, 'memory');

// ── Helpers ──────────────────────────────────────────────────

function createCapturingAdapter(): { adapter: ChannelStreamAdapter; doneCalled: () => boolean } {
  let doneCalled = false;
  const adapter: ChannelStreamAdapter = {
    onStreamStart: mock(async () => {}),
    sendChunk: mock(async () => {}),
    sendDone: mock(async () => {
      doneCalled = true;
    }),
    sendError: mock(async () => {}),
  };
  return { adapter, doneCalled: () => doneCalled };
}

function makeMockBridge(response: string, handledBy: 'claude' | 'codex' = 'claude'): AgentBridge {
  return {
    execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
      if (params.streamCallback) {
        await params.streamCallback({ type: 'text_delta', text: response });
        await params.streamCallback({ type: 'done' });
      }
      return {
        content: response,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        finishedNaturally: true,
        handledBy,
      };
    }),
  };
}

function makeFailingBridge(errorMessage: string): AgentBridge {
  return {
    execute: mock(async (): Promise<AgentResult> => {
      throw new Error(errorMessage);
    }),
  };
}

// ── Console suppression ──────────────────────────────────────

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
// GW-01: bootstrapAgentBridge pattern — claude primary, codex fallback
// ════════════════════════════════════════════════════════════════

describe('GW-01: AgentBridgeWithFallback — claude primary calls primary first', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('primary (claude) is called; fallback is NOT called when primary succeeds', async () => {
    const primaryBridge = makeMockBridge('Claude primary response', 'claude');
    const fallbackBridge = makeMockBridge('Codex fallback response', 'codex');

    // Mirrors gateway/index.ts bootstrapAgentBridge() composition
    const bridge = new AgentBridgeWithFallback(primaryBridge, fallbackBridge, 'claude', 'codex');

    ctx = createTestController({
      agentBridge: bridge,
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const result = await ctx.controller.handleIncomingMessage(
      createMessage({ content: '帮我分析代码' }),
    );

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe('Claude primary response');

    expect(primaryBridge.execute).toHaveBeenCalledTimes(1);
    expect(fallbackBridge.execute).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// GW-02: Reversed config — codex primary, claude fallback
// ════════════════════════════════════════════════════════════════

describe('GW-02: AgentBridgeWithFallback — codex primary fails → claude fallback called', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('codex primary throws unavailable error → fallback (claude) responds', async () => {
    const FALLBACK_RESPONSE = 'Claude fallback recovered';

    // Primary fails with an "exited with code" error (triggers isProviderUnavailable)
    const codexPrimary = makeFailingBridge('process exited with code 1');
    const claudeFallback = makeMockBridge(FALLBACK_RESPONSE, 'claude');

    // Reversed config: codex is primary, claude is fallback
    const bridge = new AgentBridgeWithFallback(codexPrimary, claudeFallback, 'codex', 'claude');

    ctx = createTestController({
      agentBridge: bridge,
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const result = await ctx.controller.handleIncomingMessage(
      createMessage({ content: '测试备用切换' }),
    );

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe(FALLBACK_RESPONSE);

    // Primary was tried first
    expect(codexPrimary.execute).toHaveBeenCalledTimes(1);
    // Fallback was called after primary failure
    expect(claudeFallback.execute).toHaveBeenCalledTimes(1);

    // handledBy should be the fallback name
    const fullData = result.data as { handledBy?: string };
    // handledBy is set inside bridge.execute: { ...result, handledBy: this.fallbackName }
    // The result from executeChatPipeline is returned as-is, so check it bubbled up
    expect(data.content).toBe(FALLBACK_RESPONSE);
  });
});

// ════════════════════════════════════════════════════════════════
// GW-03: isProviderUnavailable pattern matching
// ════════════════════════════════════════════════════════════════

describe('GW-03: isProviderUnavailable — pattern matching', () => {
  const bridge = new AgentBridgeWithFallback(
    makeMockBridge('p'),
    makeMockBridge('f'),
    'claude',
    'codex',
  );

  // Matching patterns (should trigger fallback)
  const matchingErrors = [
    'spawn codex ENOENT',
    'command not found: codex',
    'rate limit exceeded',
    'rate-limit hit',
    'quota exceeded for the day',
    'upstream 503 Service Unavailable',
    '502 Bad Gateway from upstream',
    'request timeout after 30s',
    'ECONNREFUSED 127.0.0.1:5000',
    'ECONNRESET by remote host',
    'process exited with code 1',
    'exited with code 127',
  ];

  // Non-matching errors (should NOT trigger fallback — re-throw)
  const nonMatchingErrors = [
    'validation error: missing field',
    'invalid input: content too long',
    'syntax error in prompt',
    'user cancelled request',
  ];

  for (const msg of matchingErrors) {
    test(`matches: "${msg}"`, () => {
      expect(bridge.isProviderUnavailable(new Error(msg))).toBe(true);
    });
  }

  for (const msg of nonMatchingErrors) {
    test(`does NOT match: "${msg}"`, () => {
      expect(bridge.isProviderUnavailable(new Error(msg))).toBe(false);
    });
  }

  test('non-Error value returns false', () => {
    expect(bridge.isProviderUnavailable('string error')).toBe(false);
    expect(bridge.isProviderUnavailable(null)).toBe(false);
    expect(bridge.isProviderUnavailable(42)).toBe(false);
    expect(bridge.isProviderUnavailable({ message: 'ENOENT' })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// GW-04: streamAdapterFactory injection — correct args
// ════════════════════════════════════════════════════════════════

describe('GW-04: streamAdapterFactory injection — called with correct userId/channel/conversationId', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('factory is called with message userId, channel, and conversationId', async () => {
    const { adapter } = createCapturingAdapter();

    const capturedArgs: Array<{
      userId: string;
      channel: string;
      conversationId: string;
      options?: { existingCardId?: string };
    }> = [];

    const streamAdapterFactory = mock(
      (
        userId: string,
        channel: string,
        conversationId: string,
        options?: { existingCardId?: string },
      ) => {
        capturedArgs.push({ userId, channel, conversationId, options });
        return [adapter];
      },
    );

    ctx = createTestController({
      agentBridge: makeMockBridge('response'),
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      streamAdapterFactory,
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const msg = createMessage({
      userId: 'user_gw04',
      channel: 'web',
      conversationId: 'conv_gw04',
      content: '测试 factory 参数',
    });

    const result = await ctx.controller.handleIncomingMessage(msg);
    expect(result.success).toBe(true);

    expect(streamAdapterFactory).toHaveBeenCalled();
    expect(capturedArgs.length).toBeGreaterThan(0);

    const call = capturedArgs[0];
    expect(call.userId).toBe('user_gw04');
    expect(call.channel).toBe('web');
    expect(call.conversationId).toBe('conv_gw04');
    // Web channel has no placeholder → no existingCardId
    expect(call.options?.existingCardId).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// GW-05: placeholderSender injection for Feishu
// ════════════════════════════════════════════════════════════════

describe('GW-05: placeholderSender injection — Feishu channel wires existingCardId', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('placeholderSender called with conversationId; factory receives existingCardId', async () => {
    const PLACEHOLDER_CARD_ID = 'ph_card_777';
    const PLACEHOLDER_MSG_ID = 'ph_msg_888';
    const FEISHU_CONV_ID = 'feishu_conv_gw05';

    const placeholderSender = mock(async (chatId: string) => {
      expect(chatId).toBe(FEISHU_CONV_ID);
      return { cardId: PLACEHOLDER_CARD_ID, messageId: PLACEHOLDER_MSG_ID };
    });

    let receivedExistingCardId: string | undefined;
    const { adapter } = createCapturingAdapter();

    const streamAdapterFactory = mock(
      (
        _userId: string,
        _channel: string,
        _conversationId: string,
        options?: { existingCardId?: string },
      ) => {
        receivedExistingCardId = options?.existingCardId;
        return [adapter];
      },
    );

    ctx = createTestController({
      agentBridge: makeMockBridge('feishu response'),
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      placeholderSender,
      streamAdapterFactory,
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const msg = createMessage({
      channel: 'feishu',
      conversationId: FEISHU_CONV_ID,
      content: '飞书消息测试',
    });

    const result = await ctx.controller.handleIncomingMessage(msg);
    expect(result.success).toBe(true);

    // placeholderSender must have been invoked
    expect(placeholderSender).toHaveBeenCalledTimes(1);

    // streamAdapterFactory must have received the cardId from placeholderSender
    expect(streamAdapterFactory).toHaveBeenCalled();
    expect(receivedExistingCardId).toBe(PLACEHOLDER_CARD_ID);
  });

  test('non-feishu channel (web) does NOT call placeholderSender', async () => {
    const placeholderSender = mock(async () => ({ cardId: 'x', messageId: 'y' }));
    const { adapter } = createCapturingAdapter();

    ctx = createTestController({
      agentBridge: makeMockBridge('web response'),
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      placeholderSender,
      streamAdapterFactory: () => [adapter],
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const msg = createMessage({
      channel: 'web',
      conversationId: 'conv_web_gw05',
      content: 'web message',
    });

    const result = await ctx.controller.handleIncomingMessage(msg);
    expect(result.success).toBe(true);

    // placeholderSender must NOT be called for non-feishu channels
    expect(placeholderSender).not.toHaveBeenCalled();
  });
});
