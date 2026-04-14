/**
 * Prompt Assembly Pipeline Integration Tests (PRM-01 ~ PRM-05)
 *
 * Verifies the DD-018 session-level frozen prompt + per-turn context injection pipeline.
 *
 * Real: SystemPromptBuilder, TurnContextBuilder, PrependContextBuilder, CentralController.
 * Mock: AgentBridge (captures params), ConfigLoader, OpenViking.
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
import {
  type ControllerTestContext,
  cleanupController,
  createMessage,
  createMockOVDeps,
  createTestController,
} from './test-helpers';

// ── Constants ────────────────────────────────────────────────

const MOCK_WORKSPACE = '/tmp/test-workspace';
const USER_CONFIG_DIR = path.join(MOCK_WORKSPACE, 'memory');

// ── Capturing AgentBridge ────────────────────────────────────

interface CapturedExecute {
  params: AgentExecuteParams;
}

function createCapturingBridge(response = 'agent response'): {
  bridge: AgentBridge;
  calls: CapturedExecute[];
} {
  const calls: CapturedExecute[] = [];
  const bridge: AgentBridge = {
    execute: mock(async (params: AgentExecuteParams): Promise<AgentResult> => {
      calls.push({ params: { ...params } });
      if (params.streamCallback) {
        await params.streamCallback({ type: 'text_delta', text: response });
        await params.streamCallback({ type: 'done' });
      }
      return {
        content: response,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        finishedNaturally: true,
        handledBy: 'claude' as const,
      };
    }),
  };
  return { bridge, calls };
}

// ── Suppress console noise ───────────────────────────────────

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
// PRM-01: First message generates frozenSystemPrompt with SOUL+IDENTITY content
// ════════════════════════════════════════════════════════════════

describe('PRM-01: First message generates frozenSystemPrompt with SOUL+IDENTITY content', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('systemPrompt received by agentBridge contains identity and soul content', async () => {
    const IDENTITY_CONTENT = '# Identity\nI am a test agent.';
    const SOUL_CONTENT = '# Soul\nBe helpful and kind.';

    const ovDeps = createMockOVDeps();
    // Override configLoader to return known content
    const configLoader = {
      loadAll: mock(async () => ({
        soul: SOUL_CONTENT,
        identity: IDENTITY_CONTENT,
        user: '',
        agents: '',
      })),
      loadFile: mock(async (name: string) => {
        const files: Record<string, string> = {
          'IDENTITY.md': IDENTITY_CONTENT,
          'SOUL.md': SOUL_CONTENT,
          'AGENTS.md': '# Agents\nCore protocol.',
        };
        return files[name] ?? '';
      }),
      invalidateCache: mock(() => {}),
    } as unknown as CentralControllerDeps['configLoader'];

    const { bridge, calls } = createCapturingBridge();

    ctx = createTestController({
      agentBridge: bridge,
      lightLLM: undefined, // no gateway, goes directly to agentBridge
      configLoader,
      ...ovDeps,
    });

    const msg = createMessage({ content: '帮我分析一下代码' }); // complex → hits agentBridge
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    expect(calls.length).toBeGreaterThan(0);

    const systemPrompt = calls[0]?.params.systemPrompt ?? '';
    // frozenSystemPrompt must include identity and soul content
    expect(systemPrompt).toContain('Test Agent');
    expect(systemPrompt).toContain('Be helpful');
  });
});

// ════════════════════════════════════════════════════════════════
// PRM-02: Second message reuses frozenSystemPrompt (not rebuilt)
// ════════════════════════════════════════════════════════════════

describe('PRM-02: Second message reuses frozenSystemPrompt from session (not rebuilt)', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('configLoader.loadFile called fewer times on second message than first', async () => {
    const ovDeps = createMockOVDeps();
    const loadFileMock = mock(async (name: string) => {
      const files: Record<string, string> = {
        'IDENTITY.md': '# Identity\nTest Agent.',
        'SOUL.md': '# Soul\nBe helpful.',
        'AGENTS.md': '# Agents\nCore protocol.',
      };
      return files[name] ?? '';
    });
    const configLoader = {
      loadAll: mock(async () => ({ soul: '', identity: '', user: '', agents: '' })),
      loadFile: loadFileMock,
      invalidateCache: mock(() => {}),
    } as unknown as CentralControllerDeps['configLoader'];

    const { bridge } = createCapturingBridge();

    ctx = createTestController({
      agentBridge: bridge,
      lightLLM: undefined,
      configLoader,
      ...ovDeps,
    });

    const userId = 'user_prm02';
    const conversationId = 'conv_prm02';

    // First message: frozenSystemPrompt is built → loadFile called for IDENTITY/SOUL/AGENTS
    const msg1 = createMessage({ content: '帮我分析代码', userId, conversationId });
    await ctx.controller.handleIncomingMessage(msg1);

    const callsAfterFirst = (loadFileMock.mock.calls as unknown[]).length;

    // Second message: same session → frozenSystemPrompt already frozen, should NOT rebuild
    const msg2 = createMessage({ content: '再分析一次', userId, conversationId });
    await ctx.controller.handleIncomingMessage(msg2);

    const callsAfterSecond = (loadFileMock.mock.calls as unknown[]).length;

    // The second message should not have triggered any new loadFile calls for the frozen sections
    // (IDENTITY/SOUL/AGENTS are only loaded during initial build)
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });
});

// ════════════════════════════════════════════════════════════════
// PRM-03: TurnContext includes memory retrieval and task guidance
// ════════════════════════════════════════════════════════════════

describe('PRM-03: TurnContext includes task guidance in systemPrompt', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('finalSystemPrompt contains task-guidance XML tags from TurnContextBuilder', async () => {
    const { bridge, calls } = createCapturingBridge();

    ctx = createTestController({
      agentBridge: bridge,
      lightLLM: undefined,
    });

    const msg = createMessage({ content: '帮我分析一下代码' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    expect(calls.length).toBeGreaterThan(0);

    const systemPrompt = calls[0]?.params.systemPrompt ?? '';
    // TurnContext always injects <task-guidance> for non-empty taskType/executionMode
    expect(systemPrompt).toContain('<task-guidance>');
    expect(systemPrompt).toContain('</task-guidance>');
  });
});

// ════════════════════════════════════════════════════════════════
// PRM-04: prependContext injected only on first message, empty on second
// ════════════════════════════════════════════════════════════════

describe('PRM-04: prependContext only injected on first message', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('first call has non-empty prependContext; second call has empty prependContext', async () => {
    const { bridge, calls } = createCapturingBridge();

    // Must use lightLLM so IntelligenceGateway path is active; complex message forces
    // gateway to call agentBridge.execute(agentParams) which carries real prependContext.
    ctx = createTestController({
      agentBridge: bridge,
      // lightLLM present → IntelligenceGateway created; "帮我分析代码" triggers mightNeedTools
      // → canHandleDirectly=false → agentBridge.execute(agentParams) with real prependContext
    });

    const userId = 'user_prm04';
    const conversationId = 'conv_prm04';

    // Complex message → IntelligenceGateway passes full agentParams to agentBridge
    const msg1 = createMessage({ content: '帮我分析代码', userId, conversationId });
    await ctx.controller.handleIncomingMessage(msg1);

    const msg2 = createMessage({ content: '帮我继续分析', userId, conversationId });
    await ctx.controller.handleIncomingMessage(msg2);

    expect(calls.length).toBe(2);

    // First message: prependContext must be populated (contains <system-reminder>)
    const firstPrepend = calls[0]?.params.prependContext ?? '';
    expect(firstPrepend).toContain('<system-reminder>');

    // Second message: prependContext must be empty (only first message gets prepend)
    const secondPrepend = calls[1]?.params.prependContext ?? '';
    expect(secondPrepend).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// PRM-05: agentParams received by bridge contains complete fields
// ════════════════════════════════════════════════════════════════

describe('PRM-05: agentBridge.execute receives complete AgentExecuteParams via IntelligenceGateway', () => {
  let ctx: ControllerTestContext;
  afterEach(() => cleanupController(ctx));

  test('params contain systemPrompt, prependContext, and mcpConfig when routed via gateway', async () => {
    const { bridge, calls } = createCapturingBridge();

    // lightLLM must be present so IntelligenceGateway is wired;
    // "帮我分析代码" → mightNeedTools=true → canHandleDirectly=false
    // → gateway calls agentBridge.execute(agentParams) with full params assembled by orchestrate()
    ctx = createTestController({
      agentBridge: bridge,
      // default createTestController creates lightLLM mock — keep it
    });

    const msg = createMessage({ content: '帮我分析代码' });
    const result = await ctx.controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    expect(calls.length).toBeGreaterThan(0);

    const params = calls[0]?.params;
    expect(params).toBeDefined();

    // systemPrompt must be a non-empty string
    expect(typeof params?.systemPrompt).toBe('string');
    expect((params?.systemPrompt ?? '').length).toBeGreaterThan(0);

    // prependContext must be present (first message → non-empty <system-reminder> block)
    expect(typeof params?.prependContext).toBe('string');
    expect(params?.prependContext).toContain('<system-reminder>');

    // mcpConfig must be an object (even if empty tools list)
    expect(typeof params?.mcpConfig).toBe('object');
    expect(params?.mcpConfig).not.toBeNull();
  });
});
