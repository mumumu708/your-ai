/**
 * Streaming Pipeline Gap Tests (STR-04 ~ STR-06)
 *
 * Fills gaps in the existing streaming.integration.test.ts:
 *   STR-04: Placeholder card → stream update → close → add buttons (Feishu flow)
 *   STR-05: streamResultPromise resolves after done event
 *   STR-06: Gateway quick path pushes text_delta + done to streamCallback
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentBridge,
  AgentExecuteParams,
  AgentResult,
} from '../../kernel/agents/agent-bridge';
import type { CentralControllerDeps } from '../../kernel/central-controller';
import type { ChannelStreamAdapter } from '../../kernel/streaming/stream-protocol';
import {
  type ControllerTestContext,
  cleanupController,
  createMessage,
  createMockLightLLM,
  createTestController,
} from './test-helpers';

// ── Constants ────────────────────────────────────────────────

const MOCK_WORKSPACE = '/tmp/test-workspace';
const USER_CONFIG_DIR = path.join(MOCK_WORKSPACE, 'memory');

// ── Capturing adapter ────────────────────────────────────────

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
// STR-04: Placeholder card → stream update → close (Feishu flow)
// ════════════════════════════════════════════════════════════════

describe('STR-04: Feishu placeholderSender → existingCardId wired into streamAdapterFactory', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('placeholderSender called, factory receives existingCardId, adapter.sendDone called', async () => {
    const CARD_ID = 'card_001';
    const MESSAGE_ID = 'msg_001';
    const AGENT_RESPONSE = 'Feishu streaming response';

    const placeholderSender = mock(async (_chatId: string) => ({
      cardId: CARD_ID,
      messageId: MESSAGE_ID,
    }));

    let capturedExistingCardId: string | undefined;
    const { adapter } = createCapturingAdapter();

    const streamAdapterFactory = mock(
      (
        _userId: string,
        _channel: string,
        _conversationId: string,
        options?: { existingCardId?: string },
      ) => {
        capturedExistingCardId = options?.existingCardId;
        return [adapter];
      },
    );

    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: AGENT_RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: AGENT_RESPONSE,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    ctx = createTestController({
      agentBridge,
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      placeholderSender,
      streamAdapterFactory,
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const msg = createMessage({
      channel: 'feishu',
      conversationId: 'conv_feishu_001',
    });

    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);

    // placeholderSender must have been called with the conversationId
    expect(placeholderSender).toHaveBeenCalledTimes(1);
    expect(placeholderSender.mock.calls[0][0]).toBe('conv_feishu_001');

    // streamAdapterFactory must have received the existingCardId from placeholder
    expect(streamAdapterFactory).toHaveBeenCalled();
    expect(capturedExistingCardId).toBe(CARD_ID);

    // adapter.sendDone must have been called with the agent response
    expect(adapter.sendDone).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// STR-05: streamResultPromise resolves after done event
// ════════════════════════════════════════════════════════════════

describe('STR-05: streamResultPromise resolves after done event (no hang)', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('agentBridge sends text_delta + done → handleIncomingMessage resolves, sendDone called', async () => {
    const RESPONSE = 'streaming done test';
    const { adapter, captured } = createCapturingAdapter();

    const agentBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: RESPONSE });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: RESPONSE,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    ctx = createTestController({
      agentBridge,
      lightLLM: undefined as unknown as CentralControllerDeps['lightLLM'],
      streamAdapterFactory: () => [adapter],
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    const msg = createMessage({ content: 'test streaming resolve' });

    // Race against timeout — if streamResultPromise hangs this will reject
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('TIMEOUT: handleIncomingMessage hung waiting for done')),
        5000,
      ),
    );

    const result = await Promise.race([ctx.controller.handleIncomingMessage(msg), timeout]);

    expect(result.success).toBe(true);
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe(RESPONSE);
    expect(adapter.sendDone).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════
// STR-06: Gateway quick path manually pushes text_delta + done
// ════════════════════════════════════════════════════════════════

describe('STR-06: Gateway quick path pushes text_delta+done to streamCallback', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('LightLLM response (non-safety phrase) → adapter receives text_delta content + sendDone', async () => {
    const LLM_RESPONSE = '这是一个简单的问候';
    const lightLLM = createMockLightLLM(LLM_RESPONSE);

    // agentBridge should NOT be called for this simple gateway-handled message
    const agentBridge: AgentBridge = {
      execute: mock(async (): Promise<AgentResult> => {
        throw new Error('agentBridge should not be called for gateway quick path');
      }),
    };

    const { adapter, captured } = createCapturingAdapter();

    ctx = createTestController({
      agentBridge,
      lightLLM,
      streamAdapterFactory: () => [adapter],
      taskStore: undefined as unknown as CentralControllerDeps['taskStore'],
    });

    // Simple greeting → gateway canHandleDirectly=true → LightLLM quickAnswer
    const msg = createMessage({ content: '你好' });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT: gateway quick path hung')), 5000),
    );

    const result = await Promise.race([ctx.controller.handleIncomingMessage(msg), timeout]);

    expect(result.success).toBe(true);
    const data = result.data as { content: string; channel?: string };
    expect(data.content).toBe(LLM_RESPONSE);
    expect(data.channel).toBe('light_llm');

    // agentBridge must NOT have been called
    expect(agentBridge.execute).not.toHaveBeenCalled();

    // adapter.sendDone must have been called with the LightLLM content
    // This tests the `if (gatewayResult.handledBy === 'gateway' && streamCallback)` path
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe(LLM_RESPONSE);
  });
});
