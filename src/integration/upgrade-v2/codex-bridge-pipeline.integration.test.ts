/**
 * Codex Bridge Pipeline Integration Tests (CBP-01 ~ CBP-06)
 *
 * Tests the FULL pipeline from CentralController.handleIncomingMessage()
 * through CodexAgentBridge to stream adapters, mocking only at the
 * process boundary (child_process.spawn).
 *
 * Real instances: CodexAgentBridge, AgentBridgeWithFallback,
 *   IntelligenceGateway, StreamHandler, StreamContentFilter.
 *
 * These tests catch bugs that unit tests missed:
 *   - stdin deadlock (stdio: 'pipe' vs 'ignore')
 *   - Missing --skip-git-repo-check
 *   - JSONL format mismatch (message/assistant vs item.completed/agent_message)
 *   - Missing stream done event
 *   - Fallback not triggering on CLI exit code
 */
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { AgentBridge, AgentExecuteParams, AgentResult } from '../../kernel/agents/agent-bridge';
import { AgentBridgeWithFallback } from '../../kernel/agents/agent-bridge-fallback';
import { CodexAgentBridge } from '../../kernel/agents/codex-agent-bridge';
import type { CentralControllerDeps } from '../../kernel/central-controller';
import type { ChannelStreamAdapter } from '../../kernel/streaming/stream-protocol';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';
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

// ── Mock Process Factory ─────────────────────────────────────

type MockProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof mock>;
  stdin: null;
};

function createMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  proc.stdin = null;
  return proc;
}

/** Emit a Codex-format agent_message JSONL line */
function emitCodexMessage(proc: MockProcess, text: string): void {
  const jsonl = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  });
  proc.stdout.emit('data', Buffer.from(`${jsonl}\n`));
}

// ── Capturing Stream Adapter ─────────────────────────────────

function createCapturingAdapter() {
  const captured = {
    started: false,
    chunks: [] as Array<{ text: string }>,
    doneText: '',
    doneCalled: false,
    errors: [] as string[],
  };

  const adapter: ChannelStreamAdapter = {
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

// ── Test Suite ───────────────────────────────────────────────

let spawnSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  spawnSpy = spyOn(child_process, 'spawn');

  // Bypass onboarding
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'SOUL.md'), '# Soul\nBe helpful.');
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'IDENTITY.md'), '# Identity\nTest Agent.');
  fs.writeFileSync(path.join(USER_CONFIG_DIR, 'AGENTS.md'), '# Agents\nCore protocol.');

  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  spawnSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ════════════════════════════════════════════════════════════════
// CBP-01: Happy path — Codex JSONL agent_message flows to card
// ════════════════════════════════════════════════════════════════

describe('CBP-01: Codex happy path — JSONL item.completed flows to card', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('agent_message text reaches stream adapter as text_delta → sendDone', async () => {
    const codexBridge = new CodexAgentBridge();
    const { adapter, captured } = createCapturingAdapter();

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        emitCodexMessage(proc, 'Hello from Codex');
        proc.emit('close', 0);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    ctx = createPipelineTestController({
      agentBridge: codexBridge,
      lightLLM: undefined, // force complex path
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'hello' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe('Hello from Codex');

    // Stream adapter received content
    expect(captured.started).toBe(true);
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toBe('Hello from Codex');
    expect(captured.chunks.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════
// CBP-02: stdin is 'ignore' — no deadlock
// ════════════════════════════════════════════════════════════════

describe('CBP-02: stdin=ignore prevents deadlock', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('spawn called with stdio ignore for stdin', async () => {
    const codexBridge = new CodexAgentBridge();

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        emitCodexMessage(proc, 'response');
        proc.emit('close', 0);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    ctx = createPipelineTestController({
      agentBridge: codexBridge,
      lightLLM: undefined,
    });

    const msg = createMessage({ content: 'test' });

    // Race against timeout to detect deadlock
    const result = await Promise.race([
      ctx.controller.handleIncomingMessage(msg),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DEADLOCK: handleIncomingMessage hung')), 5000),
      ),
    ]);

    expect(result.success).toBe(true);

    // Verify stdio config
    const spawnCall = spawnSpy.mock.calls[0];
    const options = spawnCall?.[2] as { stdio?: string[] };
    expect(options?.stdio?.[0]).toBe('ignore');
  });
});

// ════════════════════════════════════════════════════════════════
// CBP-03: --skip-git-repo-check in args
// ════════════════════════════════════════════════════════════════

describe('CBP-03: --skip-git-repo-check present in args', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('codex exec args include --skip-git-repo-check', async () => {
    const codexBridge = new CodexAgentBridge();

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        emitCodexMessage(proc, 'ok');
        proc.emit('close', 0);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    ctx = createPipelineTestController({
      agentBridge: codexBridge,
      lightLLM: undefined,
    });

    const msg = createMessage({ content: 'test' });
    await ctx.controller.handleIncomingMessage(msg);

    const args = spawnSpy.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--full-auto');
    expect(args).toContain('--json');
  });
});

// ════════════════════════════════════════════════════════════════
// CBP-04: done event fires on process close (multi-message)
// ════════════════════════════════════════════════════════════════

describe('CBP-04: done event fires after process close', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('multiple agent_messages are joined and done event resolves stream', async () => {
    const codexBridge = new CodexAgentBridge();
    const { adapter, captured } = createCapturingAdapter();

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        emitCodexMessage(proc, 'Part 1');
        emitCodexMessage(proc, 'Part 2');
        proc.emit('close', 0);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    ctx = createPipelineTestController({
      agentBridge: codexBridge,
      lightLLM: undefined,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'test' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toContain('Part 1');
    expect(data.content).toContain('Part 2');

    // sendDone was called exactly once
    expect(adapter.sendDone).toHaveBeenCalledTimes(1);
    expect(captured.doneCalled).toBe(true);
    // Both parts are in the streamed content
    expect(captured.doneText).toContain('Part 1');
    expect(captured.doneText).toContain('Part 2');
  });
});

// ════════════════════════════════════════════════════════════════
// CBP-05: Non-zero exit → AgentBridgeWithFallback triggers Claude
// ════════════════════════════════════════════════════════════════

describe('CBP-05: Codex exit code 1 → fallback to Claude', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('codex crashes with exit code 1, fallback bridge is called', async () => {
    const codexBridge = new CodexAgentBridge();
    const fallbackBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'Claude recovered' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'Claude recovered',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const bridge = new AgentBridgeWithFallback(codexBridge, fallbackBridge, 'codex', 'claude');

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('Not inside a trusted directory\n'));
        proc.emit('close', 1);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge: bridge,
      lightLLM: undefined,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'hello' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe('Claude recovered');
    expect(fallbackBridge.execute).toHaveBeenCalled();
    expect(captured.doneText).toBe('Claude recovered');
  });
});

// ════════════════════════════════════════════════════════════════
// CBP-06: ENOENT spawn error → fallback triggers
// ════════════════════════════════════════════════════════════════

describe('CBP-06: Codex binary not found → fallback to Claude', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('spawn ENOENT error triggers fallback bridge', async () => {
    const codexBridge = new CodexAgentBridge();
    const fallbackBridge: AgentBridge = {
      execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
        if (params.streamCallback) {
          await params.streamCallback({ type: 'text_delta', text: 'Fallback response' });
          await params.streamCallback({ type: 'done' });
        }
        return {
          content: 'Fallback response',
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          finishedNaturally: true,
          handledBy: 'claude',
        };
      }),
    };

    const bridge = new AgentBridgeWithFallback(codexBridge, fallbackBridge, 'codex', 'claude');

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        proc.emit('error', err);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    ctx = createPipelineTestController({
      agentBridge: bridge,
      lightLLM: undefined,
      streamAdapterFactory: () => [adapter],
    });

    const { adapter, captured } = createCapturingAdapter();

    // Re-create controller with adapter
    cleanupController(ctx);
    ctx = createPipelineTestController({
      agentBridge: bridge,
      lightLLM: undefined,
      streamAdapterFactory: () => [adapter],
    });

    const msg = createMessage({ content: 'hello' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    expect(data.content).toBe('Fallback response');
    expect(fallbackBridge.execute).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// CBP-07: Safety valve — LightLLM → safety phrase → Codex bridge
// ════════════════════════════════════════════════════════════════

describe('CBP-07: Safety valve triggers Codex via IntelligenceGateway', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('LightLLM returns safety phrase → gateway escalates to Codex → card shows Codex response', async () => {
    const SAFETY_PHRASE = '我需要更仔细地处理这个问题';
    const codexBridge = new CodexAgentBridge();

    // LightLLM returns the safety phrase for gateway quick answer
    const lightLLM = createMockLightLLM(SAFETY_PHRASE);

    spawnSpy.mockImplementation(() => {
      const proc = createMockProcess();
      queueMicrotask(() => {
        emitCodexMessage(proc, 'Deep analysis result from Codex');
        proc.emit('close', 0);
      });
      return proc as unknown as child_process.ChildProcess;
    });

    const { adapter, captured } = createCapturingAdapter();

    ctx = createPipelineTestController({
      agentBridge: codexBridge,
      lightLLM,
      streamAdapterFactory: () => [adapter],
    });

    // Simple message that gateway would handle directly
    const msg = createMessage({ content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    const data = result.data as { content: string };
    // Response should come from Codex, not the safety phrase
    expect(data.content).not.toBe(SAFETY_PHRASE);
    expect(data.content).toContain('Deep analysis result from Codex');

    // Stream adapter received the Codex content
    expect(captured.doneCalled).toBe(true);
    expect(captured.doneText).toContain('Deep analysis result from Codex');
  });
});
