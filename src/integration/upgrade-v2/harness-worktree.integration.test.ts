import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
/**
 * DD-020 HW series: Harness Worktree Integration Tests
 *
 * Tests the full harness worktree lifecycle:
 *   handleIncomingMessage -> classification -> handleHarnessTask -> WorktreePool -> executeChatPipeline
 *   /end -> handleHarnessEnd -> closeSession -> onSessionClose -> worktreePool.release
 *
 * All LLM/OV backends are mocked. WorktreePool uses createMockWorktreePool().
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '../../kernel/agents/agent-runtime';
import { CentralController } from '../../kernel/central-controller';
import type { WorktreePool } from '../../kernel/sessioning';
import type { WorkspaceManager } from '../../kernel/workspace';
import {
  type ControllerTestContext,
  cleanupController,
  createMessage,
  createMockChannel,
  createMockAgentBridge,
  createMockLightLLM,
  createMockMediaProcessor,
  createMockOVDeps,
  createMockWorktreePool,
  type createTestController,
} from './test-helpers';

// ── Test workspace setup ────────────────────────────────────

const TEST_USER_SPACE = join(tmpdir(), `your-ai-hw-test-${Date.now()}`);
const ADMIN_USER_ID = 'user_test';
const NON_ADMIN_USER_ID = 'user_non_admin';

function createCorrectWorkspaceManager(): WorkspaceManager {
  const basePath = join(TEST_USER_SPACE, ADMIN_USER_ID);
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

/**
 * Creates a CentralController configured for harness testing:
 * - Classifier mock returns 'harness' for /harness messages
 * - Correct WorkspaceManager shape
 * - No taskStore (bypasses TaskDispatcher, uses direct orchestrate path)
 */
function createHarnessController(
  extraOverrides?: Parameters<typeof createTestController>[0],
): ControllerTestContext {
  CentralController.resetInstance();

  const worktreePool = createMockWorktreePool();
  const agentBridge = createMockAgentBridge();
  const lightLLM = createMockLightLLM();
  const ovDeps = createMockOVDeps();

  const deps = {
    agentBridge,
    lightLLM,
    workspaceManager: createCorrectWorkspaceManager(),
    mediaProcessor: createMockMediaProcessor(),
    worktreePool,
    // Mock classifier: returns 'harness' for /harness messages, 'chat' otherwise
    classifier: {
      classify: mock(async (content: string) => ({
        taskType:
          content.startsWith('/harness') || content.startsWith('harness:')
            ? ('harness' as const)
            : ('chat' as const),
        complexity: 'complex' as const,
        reason: 'mock classification',
        confidence: 0.95,
        classifiedBy: 'mock' as const,
        costUsd: 0,
      })),
    },
    ...ovDeps,
    // No sessionStore/taskStore — bypasses TaskDispatcher, uses direct orchestrate
    ...extraOverrides,
  };

  const controller = CentralController.getInstance(
    deps as Parameters<typeof CentralController.getInstance>[0],
  );
  // createStores not used — we return a minimal context
  return {
    controller,
    deps: deps as unknown as ControllerTestContext['deps'],
    db: null as unknown as ControllerTestContext['db'],
    sessionStore: null as unknown as ControllerTestContext['sessionStore'],
    taskStore: null as unknown as ControllerTestContext['taskStore'],
  };
}

// ── Shared state ────────────────────────────────────────────

let ctx: ControllerTestContext;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  process.env.ADMIN_USER_IDS = ADMIN_USER_ID;
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

  // Ensure SOUL.md exists so onboarding is skipped
  const memDir = join(TEST_USER_SPACE, ADMIN_USER_ID, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'SOUL.md'), 'Test Agent', 'utf-8');

  // Also for non-admin user
  const nonAdminMemDir = join(TEST_USER_SPACE, NON_ADMIN_USER_ID, 'memory');
  mkdirSync(nonAdminMemDir, { recursive: true });
  writeFileSync(join(nonAdminMemDir, 'SOUL.md'), 'Test Agent', 'utf-8');
});

afterEach(() => {
  if (ctx) cleanupController(ctx);
  logSpy?.mockRestore();
  errorSpy?.mockRestore();
  warnSpy?.mockRestore();
  process.env.ADMIN_USER_IDS = undefined;
});

// ── HW-01: First harness message -> worktreePool.acquire -> session binds slotId/path/branch ──

describe('HW-01: First harness message acquires worktree and binds session', () => {
  test('session should have harnessWorktreeSlotId, harnessWorktreePath, and task uses cwdOverride', async () => {
    ctx = createHarnessController();
    const { controller, deps } = ctx;
    const worktreePool = deps.worktreePool as WorktreePool;
    const acquireMock = worktreePool.acquire as ReturnType<typeof mock>;

    const msg = createMessage({
      userId: ADMIN_USER_ID,
      content: '/harness add memory cache layer',
      conversationId: 'conv_hw01',
    });

    const result = await controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);

    // worktreePool.acquire was called exactly once
    expect(acquireMock).toHaveBeenCalledTimes(1);

    // Branch name was generated from the message content
    const acquireArgs = acquireMock.mock.calls[0];
    expect(acquireArgs[1]).toMatch(/^agent\//);

    // Verify session was bound — access SessionManager to inspect session state
    const sessionManager = (
      controller as unknown as { sessionManager: { getSessionByKey: (k: string) => unknown } }
    ).sessionManager;
    const sessionKey = `${ADMIN_USER_ID}:web:conv_hw01`;
    const session = sessionManager.getSessionByKey(sessionKey) as
      | Record<string, unknown>
      | undefined;

    expect(session).toBeDefined();
    expect(session?.harnessWorktreeSlotId).toBeTruthy();
    expect(session?.harnessWorktreePath).toBeTruthy();
    expect(typeof session?.harnessWorktreeSlotId).toBe('string');
    expect((session?.harnessWorktreePath as string).length).toBeGreaterThan(0);
  });
});

// ── HW-02: Follow-up harness message reuses worktree, no re-acquire ──

describe('HW-02: Follow-up harness message reuses worktree', () => {
  test('worktreePool.acquire called only once across two messages; second reuses same cwdOverride', async () => {
    ctx = createHarnessController();
    const { controller, deps } = ctx;
    const worktreePool = deps.worktreePool as WorktreePool;
    const acquireMock = worktreePool.acquire as ReturnType<typeof mock>;

    // First message: triggers acquire
    const msg1 = createMessage({
      userId: ADMIN_USER_ID,
      content: '/harness fix telegram timeout',
      conversationId: 'conv_hw02',
    });
    await controller.handleIncomingMessage(msg1);
    expect(acquireMock).toHaveBeenCalledTimes(1);

    // Capture the worktree path that was assigned
    const sessionManager = (
      controller as unknown as { sessionManager: { getSessionByKey: (k: string) => unknown } }
    ).sessionManager;
    const sessionKey = `${ADMIN_USER_ID}:web:conv_hw02`;
    const session = sessionManager.getSessionByKey(sessionKey) as Record<string, unknown>;
    const firstWorktreePath = session.harnessWorktreePath;

    // Second message: same conversation -> session already has worktree -> forces harness via rule
    const msg2 = createMessage({
      userId: ADMIN_USER_ID,
      content: 'continue fixing that timeout bug',
      conversationId: 'conv_hw02',
    });
    await controller.handleIncomingMessage(msg2);

    // acquire should NOT have been called a second time
    expect(acquireMock).toHaveBeenCalledTimes(1);

    // Session still has the same worktree path
    const sessionAfter = sessionManager.getSessionByKey(sessionKey) as Record<string, unknown>;
    expect(sessionAfter.harnessWorktreePath).toBe(firstWorktreePath);
  });
});

// ── HW-03: handleHarness + forceComplex=true -> executeChatPipeline receives forceComplex ──

describe('HW-03: Harness task always passes forceComplex=true to execution layer', () => {
  test('execution layer receives forceComplex=true or complexity=complex for harness tasks', async () => {
    ctx = createHarnessController();
    const { controller } = ctx;

    // When IntelligenceGateway is available, executeChatPipeline routes through it.
    // Spy on the gateway to verify harness-specific params (complexity + maxTurns).
    // Also spy on agentRuntime.execute as fallback path.
    const gateway = (
      controller as unknown as { intelligenceGateway?: { handle: (...args: unknown[]) => unknown } }
    ).intelligenceGateway;
    const agentRuntime = (controller as unknown as { agentRuntime: AgentRuntime }).agentRuntime;

    let gatewayCaptured: Record<string, unknown> | null = null;
    let agentRuntimeCaptured: Record<string, unknown> | null = null;

    const gatewaySpy = gateway
      ? spyOn(gateway, 'handle').mockImplementation(async (params: unknown) => {
          gatewayCaptured = params as Record<string, unknown>;
          return {
            content: 'harness gateway response',
            handledBy: 'agent',
            tokenUsage: { inputTokens: 10, outputTokens: 5, totalCost: 0.001 },
            toolsUsed: [],
          };
        })
      : null;

    const executeSpy = spyOn(agentRuntime, 'execute').mockResolvedValue({
      content: 'harness response',
      toolsUsed: [],
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalCost: 0.001 },
      complexity: 'complex',
      channel: 'agent_sdk',
    });

    const msg = createMessage({
      userId: ADMIN_USER_ID,
      content: '/harness implement new feature',
      conversationId: 'conv_hw03',
    });
    await controller.handleIncomingMessage(msg);

    if (gatewaySpy && gatewayCaptured) {
      // Gateway path: verify harness params
      expect(gatewayCaptured.complexity).toBe('complex');
      expect(gatewayCaptured.taskType).toBe('harness');
      // Harness gets 100 maxTurns vs 30 for normal tasks
      const agentParams = gatewayCaptured.agentParams as Record<string, unknown>;
      expect(agentParams.maxTurns).toBe(100);
    } else {
      // Fallback path: verify forceComplex on agentRuntime.execute
      expect(executeSpy).toHaveBeenCalled();
      agentRuntimeCaptured = executeSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(agentRuntimeCaptured.forceComplex).toBe(true);
    }

    gatewaySpy?.mockRestore();
    executeSpy.mockRestore();
  });
});

// ── HW-04: Non-admin user harness -> downgrade to chat, no worktree acquire ──

describe('HW-04: Non-admin user harness is downgraded to chat', () => {
  test('task.type becomes chat; worktreePool.acquire NOT called', async () => {
    // Need a workspace manager that returns correct shape for non-admin user too
    const nonAdminBasePath = join(TEST_USER_SPACE, NON_ADMIN_USER_ID);
    ctx = createHarnessController({
      workspaceManager: {
        initializeWithMcp: mock((_ctx: unknown) => ({
          absolutePath: nonAdminBasePath,
          claudeDir: join(nonAdminBasePath, '.claude'),
          settingsPath: join(nonAdminBasePath, '.claude', 'settings.json'),
          memoryDir: join(nonAdminBasePath, 'memory'),
          mcpJsonPath: join(nonAdminBasePath, '.mcp.json'),
          skillsDir: join(nonAdminBasePath, '.claude', 'skills'),
        })),
        getWorkspacePath: mock(() => ({
          absolutePath: nonAdminBasePath,
        })),
      } as unknown as WorkspaceManager,
    });
    const { controller, deps } = ctx;
    const worktreePool = deps.worktreePool as WorktreePool;
    const acquireMock = worktreePool.acquire as ReturnType<typeof mock>;

    // Spy on agentRuntime to verify no forceComplex
    const agentRuntime = (controller as unknown as { agentRuntime: AgentRuntime }).agentRuntime;
    const executeSpy = spyOn(agentRuntime, 'execute').mockResolvedValue({
      content: 'normal chat response',
      toolsUsed: [],
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalCost: 0.001 },
      complexity: 'simple',
      channel: 'light_llm',
    });

    const msg = createMessage({
      userId: NON_ADMIN_USER_ID,
      content: '/harness fix something',
      conversationId: 'conv_hw04',
    });
    const result = await controller.handleIncomingMessage(msg);

    expect(result.success).toBe(true);
    // worktreePool.acquire should NOT be called for non-admin
    expect(acquireMock).not.toHaveBeenCalled();

    // The task was downgraded: forceComplex should NOT be true (chat path doesn't set it)
    if (executeSpy.mock.calls.length > 0) {
      const executeCall = executeSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(executeCall.forceComplex).toBeUndefined();
    }

    executeSpy.mockRestore();
  });
});

// ── HW-05: /end command -> handleHarnessEnd -> summary with branch, messageCount, durationMin ──

describe('HW-05: /end command triggers handleHarnessEnd with summary', () => {
  test('result.data.content contains branch name, messageCount, durationMin', async () => {
    ctx = createHarnessController();
    const { controller } = ctx;

    // First: establish a harness session
    const msg1 = createMessage({
      userId: ADMIN_USER_ID,
      content: '/harness add cache layer',
      conversationId: 'conv_hw05',
    });
    await controller.handleIncomingMessage(msg1);

    // Send /end to close the harness session
    const endMsg = createMessage({
      userId: ADMIN_USER_ID,
      content: '/end',
      conversationId: 'conv_hw05',
    });
    const endResult = await controller.handleIncomingMessage(endMsg);

    expect(endResult.success).toBe(true);
    const content = (endResult.data as { content: string }).content;

    // handleHarnessEnd builds summary with branch, messageCount, durationMin
    expect(content).toContain('分支');
    expect(content).toContain('消息数');
    expect(content).toContain('分钟');
    // Branch should be present (from the worktree slot)
    expect(content).toContain('agent/');
  });
});

// ── HW-06: /end -> session close -> onSessionClose -> worktreePool.release ──

describe('HW-06: Session close triggers worktreePool.release via onSessionClose callback', () => {
  test('closeSession triggers onSessionClose callback which calls worktreePool.release', async () => {
    ctx = createHarnessController();
    const { controller, deps } = ctx;
    const worktreePool = deps.worktreePool as WorktreePool;
    const releaseMock = worktreePool.release as ReturnType<typeof mock>;
    const acquireMock = worktreePool.acquire as ReturnType<typeof mock>;

    // Establish harness session
    const msg1 = createMessage({
      userId: ADMIN_USER_ID,
      content: '/harness fix bug',
      conversationId: 'conv_hw06',
    });
    await controller.handleIncomingMessage(msg1);

    expect(acquireMock).toHaveBeenCalledTimes(1);

    // /end -> handleHarnessEnd -> sessionManager.closeSession
    // -> onSessionClose callback -> worktreePool.release
    const endMsg = createMessage({
      userId: ADMIN_USER_ID,
      content: '/end',
      conversationId: 'conv_hw06',
    });
    await controller.handleIncomingMessage(endMsg);

    // The onSessionClose callback wires: if (session?.harnessWorktreeSlotId) -> worktreePool.release(slotId)
    expect(releaseMock).toHaveBeenCalledTimes(1);

    // The slotId passed to release should match what acquire returned
    const acquiredSlot = await acquireMock.mock.results[0].value;
    expect(releaseMock.mock.calls[0][0]).toBe(acquiredSlot.id);
  });
});

// ── HW-07: feishu channel + admin -> maybeCreateHarnessGroupChat -> new session with groupChatId ──

describe('HW-07: Feishu admin harness creates group chat and re-resolves session', () => {
  test('session.harnessGroupChatId is set; new session uses groupChatId as conversationId', async () => {
    const groupChatId = 'oc_feishu_group_123';
    const feishuChannel = createMockChannel('feishu');
    // Override createGroupChat to return a plain string
    (feishuChannel.createGroupChat as ReturnType<typeof mock>).mockImplementation(
      async () => groupChatId,
    );

    ctx = createHarnessController({
      channelResolver: (channelType: string) => {
        if (channelType === 'feishu') return feishuChannel;
        return undefined;
      },
    });
    const { controller, deps } = ctx;
    const acquireMock = (deps.worktreePool as WorktreePool).acquire as ReturnType<typeof mock>;

    const msg = createMessage({
      userId: ADMIN_USER_ID,
      channel: 'feishu',
      content: '/harness add feishu streaming',
      conversationId: 'conv_hw07_original',
    });

    const result = await controller.handleIncomingMessage(msg);
    expect(result.success).toBe(true);

    // createGroupChat should have been called
    expect(feishuChannel.createGroupChat).toHaveBeenCalledTimes(1);

    // sendMessage should have been called to notify user about group chat
    expect(feishuChannel.sendMessage).toHaveBeenCalledTimes(1);

    // The worktree should be acquired (admin + harness)
    expect(acquireMock).toHaveBeenCalledTimes(1);

    // Verify the session was re-resolved with groupChatId as key
    const sessionManager = (
      controller as unknown as { sessionManager: { getSessionByKey: (k: string) => unknown } }
    ).sessionManager;
    const newSessionKey = `${ADMIN_USER_ID}:feishu:${groupChatId}`;
    const newSession = sessionManager.getSessionByKey(newSessionKey) as
      | Record<string, unknown>
      | undefined;

    expect(newSession).toBeDefined();
    expect(newSession?.harnessGroupChatId).toBe(groupChatId);
  });
});

// ── HW-08: Multi-turn: branch info persists in session.harnessBranch; /end shows correct branch ──

describe('HW-08: Branch info persists across multi-turn harness session', () => {
  test('session.harnessBranch is set on first message and /end summary shows correct branch', async () => {
    ctx = createHarnessController();
    const { controller, deps } = ctx;
    const acquireMock = (deps.worktreePool as WorktreePool).acquire as ReturnType<typeof mock>;

    // First message: establishes branch
    const msg1 = createMessage({
      userId: ADMIN_USER_ID,
      content: '/harness refactor classifier module',
      conversationId: 'conv_hw08',
    });
    await controller.handleIncomingMessage(msg1);

    // Capture the branch that was created
    const acquiredSlot = await acquireMock.mock.results[0].value;
    const expectedBranch = acquiredSlot.branch as string;
    expect(expectedBranch).toMatch(/^agent\//);

    // Verify session.harnessBranch was set
    const sessionManager = (
      controller as unknown as { sessionManager: { getSessionByKey: (k: string) => unknown } }
    ).sessionManager;
    const sessionKey = `${ADMIN_USER_ID}:web:conv_hw08`;
    const session = sessionManager.getSessionByKey(sessionKey) as Record<string, unknown>;
    expect(session.harnessBranch).toBe(expectedBranch);

    // Second message: follow-up (reuses same session, same branch)
    const msg2 = createMessage({
      userId: ADMIN_USER_ID,
      content: 'convert switch to strategy pattern',
      conversationId: 'conv_hw08',
    });
    await controller.handleIncomingMessage(msg2);
    expect(acquireMock).toHaveBeenCalledTimes(1); // still only 1 acquire

    // Third message: another follow-up
    const msg3 = createMessage({
      userId: ADMIN_USER_ID,
      content: 'add unit tests',
      conversationId: 'conv_hw08',
    });
    await controller.handleIncomingMessage(msg3);

    // /end -> summary should contain the correct branch
    const endMsg = createMessage({
      userId: ADMIN_USER_ID,
      content: '/end',
      conversationId: 'conv_hw08',
    });
    const endResult = await controller.handleIncomingMessage(endMsg);

    expect(endResult.success).toBe(true);
    const content = (endResult.data as { content: string }).content;

    // The summary must contain the exact branch from the worktree slot
    expect(content).toContain(expectedBranch);

    // Message count should reflect messages in the session
    expect(content).toMatch(/消息数: \d+/);
  });
});
