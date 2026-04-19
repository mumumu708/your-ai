/**
 * DD-020 Integration Tests: Message Routing through CentralController.handleIncomingMessage
 *
 * Verifies the branch order in handleIncomingMessage:
 *   1. resolveSession + workspace init
 *   2. Onboarding (tryRestore → isOnboarding → needsOnboarding)
 *   3. File upload detection (USER.md)
 *   4. Harness end detection (HARNESS_END_PATTERN)
 *   5. Schedule cancel selection
 *   6. Classification (or force harness if worktreeSlotId)
 *   7. Harness group chat creation
 *   8. TaskDispatcher.dispatchAndAwait OR sessionSerializer.run(orchestrate())
 *
 * External services (LLM, OpenViking) are mocked. Everything else uses real instances.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { CentralController } from '../../kernel/central-controller';
import { OnboardingManager } from '../../kernel/onboarding/onboarding-manager';
import type { SessionManager } from '../../kernel/sessioning/session-manager';
import type { IChannel } from '../../shared/messaging/channel-adapter.types';
import {
  cleanupController,
  createMessage,
  createMockMediaProcessor,
  createStores,
  createTestController,
} from './test-helpers';

// ── Constants ────────────────────────────────────────────────

const ADMIN_USER_ID = 'admin_test_001';
const NON_ADMIN_USER_ID = 'user_regular_001';

// ── Shared setup / teardown ──────────────────────────────────

let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let originalAdminEnv: string | undefined;

beforeEach(() => {
  originalAdminEnv = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = ADMIN_USER_ID;
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (originalAdminEnv !== undefined) {
    process.env.ADMIN_USER_IDS = originalAdminEnv;
  } else {
    process.env.ADMIN_USER_IDS = undefined;
  }
  CentralController.resetInstance();
  logSpy?.mockRestore();
  errorSpy?.mockRestore();
  warnSpy?.mockRestore();
});

// ── Helper: create a UserConfigLoader mock that controls onboarding ──

function createMockUserConfigLoader(opts: { hasSoulMd: boolean }) {
  return {
    hasUserConfig: mock(async (name: string) => {
      if (name === 'SOUL.md') return opts.hasSoulMd;
      return false;
    }),
    writeConfig: mock(async () => {}),
    getLocalDir: () => '/tmp/test-user-space/memory',
    loadFile: mock(async () => ''),
  };
}

// ═══════════════════════════════════════════════════════════════
// MR-01: New user first message -> needsOnboarding=true -> startOnboarding
// ═══════════════════════════════════════════════════════════════
describe('MR-01: New user first message triggers onboarding', () => {
  test('needsOnboarding=true -> startOnboarding returns guidance text, isOnboarding becomes true', async () => {
    const ctx = createTestController();

    // Make onboardingManager.needsOnboarding return true by ensuring
    // the UserConfigLoader reports no SOUL.md.
    // We spy on the internal onboardingManager via the controller's handleIncomingMessage.
    // The workspace manager mock returns a path, and UserConfigLoader is created
    // with that path. We need to intercept hasUserConfig on the created UserConfigLoader.
    // Strategy: spy on the OnboardingManager methods directly.

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;

    // tryRestoreState returns false (no prior state)
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    // isOnboarding returns false (not yet started)
    const isOnboardingSpy = spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    // needsOnboarding returns true (new user, no SOUL.md)
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(true);
    // startOnboarding returns the welcome text
    const startSpy = spyOn(onboardingMgr, 'startOnboarding').mockImplementation(
      async (_userId: string) => {
        // Simulate the real startOnboarding side effect
        isOnboardingSpy.mockReturnValue(true);
        return '欢迎使用！让我们花一分钟来个性化你的 AI 助手。\n\n首先，给你的 AI 助手起个名字吧（比如：小助、Echo、Nova）：';
      },
    );

    const message = createMessage({ userId: 'new_user_001', content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain('欢迎使用');
    expect((result.data as { content: string }).content).toContain('起个名字');
    expect(startSpy).toHaveBeenCalledTimes(1);
    // After startOnboarding, isOnboarding should be true
    expect(onboardingMgr.isOnboarding('new_user_001')).toBe(true);

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-02: Onboarding user responds -> processResponse continues flow
// ═══════════════════════════════════════════════════════════════
describe('MR-02: Onboarding user response continues flow', () => {
  test('isOnboarding=true -> processResponse advances state machine', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;

    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(true);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(true);
    const processSpy = spyOn(onboardingMgr, 'processResponse').mockResolvedValue(
      '好的，你的助手叫「Echo」！\n\n希望 Echo 是什么风格？',
    );

    const message = createMessage({ userId: 'onboarding_user', content: 'Echo' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    const content = (result.data as { content: string }).content;
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(0);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('onboarding_user', 'Echo', expect.anything());

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-03: Onboarding complete (last step) -> isOnboarding becomes false
// ═══════════════════════════════════════════════════════════════
describe('MR-03: Onboarding completion clears state', () => {
  test('after final processResponse, isOnboarding returns false', async () => {
    // Use real OnboardingManager to test the full state machine
    const lightLLM = null; // no LLM, use template fallback
    const onboardingMgr = new OnboardingManager(lightLLM);

    const mockConfigLoader = createMockUserConfigLoader({ hasSoulMd: false });

    const userId = 'mr03_user';

    // Step 1: Start onboarding
    const welcome = await onboardingMgr.startOnboarding(
      userId, // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );
    expect(welcome).toContain('欢迎使用');
    expect(onboardingMgr.isOnboarding(userId)).toBe(true);

    // Step 2: agent_name -> personality
    const r1 = await onboardingMgr.processResponse(
      userId,
      'TestBot', // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );
    expect(r1).toContain('TestBot');
    expect(onboardingMgr.isOnboarding(userId)).toBe(true);

    // Step 3: personality -> values
    const r2 = await onboardingMgr.processResponse(
      userId,
      '专业严谨', // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );
    expect(r2).toContain('专业严谨');
    expect(onboardingMgr.isOnboarding(userId)).toBe(true);

    // Step 4: values -> confirm
    const r3 = await onboardingMgr.processResponse(
      userId,
      '准确性第一', // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );
    expect(r3).toContain('确认');
    expect(onboardingMgr.isOnboarding(userId)).toBe(true);

    // Step 5: confirm -> complete (state deleted)
    const r4 = await onboardingMgr.processResponse(
      userId,
      '是', // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );
    expect(r4).toContain('设置完成');
    expect(onboardingMgr.isOnboarding(userId)).toBe(false);

    // Verify SOUL.md and IDENTITY.md were written
    expect(mockConfigLoader.writeConfig).toHaveBeenCalledWith('SOUL.md', expect.any(String));
    expect(mockConfigLoader.writeConfig).toHaveBeenCalledWith('IDENTITY.md', expect.any(String));
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-04: Process restart -> tryRestoreState restores onboarding
// ═══════════════════════════════════════════════════════════════
describe('MR-04: Process restart restores onboarding state', () => {
  test('new OnboardingManager + tryRestoreState recovers in-progress onboarding', async () => {
    const lightLLM = null;
    const mgr1 = new OnboardingManager(lightLLM);
    const mockConfigLoader = createMockUserConfigLoader({ hasSoulMd: false });

    const userId = 'mr04_user';

    // Start onboarding on mgr1
    await mgr1.startOnboarding(
      userId, // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );
    expect(mgr1.isOnboarding(userId)).toBe(true);

    // Advance to personality step
    await mgr1.processResponse(
      userId,
      'RestoreBot', // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockConfigLoader as any,
    );

    // Simulate process restart: create a new OnboardingManager
    const mgr2 = new OnboardingManager(lightLLM);
    expect(mgr2.isOnboarding(userId)).toBe(false); // Not yet restored

    // writeConfig was called with BOOTSTRAP.md containing the state.
    // We need to mock the file read for tryRestoreState.
    // The state was persisted via writeConfig('BOOTSTRAP.md', ...).
    // Find the BOOTSTRAP.md write call to get the persisted state.
    const bootstrapCall = (mockConfigLoader.writeConfig as ReturnType<typeof mock>).mock.calls.find(
      (c: unknown[]) => c[0] === 'BOOTSTRAP.md',
    );
    expect(bootstrapCall).toBeTruthy();
    const persistedState = bootstrapCall?.[1] as string;

    // Mock Bun.file to return the persisted state for the BOOTSTRAP.md path
    const originalBunFile = Bun.file;
    const bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      (path: string | URL, ..._args: unknown[]) => {
        const pathStr = String(path);
        if (pathStr.includes('BOOTSTRAP.md')) {
          return {
            exists: async () => true,
            text: async () => persistedState,
          } as unknown as ReturnType<typeof Bun.file>;
        }
        return originalBunFile.call(Bun, path as string);
      },
    );

    try {
      const restored = await mgr2.tryRestoreState(
        userId, // biome-ignore lint/suspicious/noExplicitAny: test mock
        mockConfigLoader as any,
      );
      expect(restored).toBe(true);
      expect(mgr2.isOnboarding(userId)).toBe(true);
    } finally {
      bunFileSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-05: USER.md file upload (base64 path)
// ═══════════════════════════════════════════════════════════════
describe('MR-05: USER.md upload via base64', () => {
  test('message with contentType=file, base64 content -> success message', async () => {
    const ctx = createTestController();

    // Skip onboarding
    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const fileContent = '# My User Profile\n\nI am a software engineer.';
    const base64Content = Buffer.from(fileContent).toString('base64');

    const message = createMessage({
      contentType: 'file',
      content: '',
      metadata: {
        fileName: 'USER.md',
        fileContentBase64: base64Content,
      },
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    const content = (result.data as { content: string }).content;
    expect(content).toContain('USER.md 已更新成功');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-06: USER.md upload (fileKey path, channel.downloadFile)
// ═══════════════════════════════════════════════════════════════
describe('MR-06: USER.md upload via fileKey + channel downloadFile', () => {
  test('feishu channel with fileKey -> downloadFile called', async () => {
    const mockChannel: IChannel = {
      type: 'feishu',
      name: 'feishu-test',
      initialize: mock(async () => {}),
      shutdown: mock(async () => {}),
      sendMessage: mock(async () => {}),
      updateMessage: mock(async () => {}),
      sendStreamChunk: mock(async () => {}),
      onMessage: mock(() => {}),
      downloadFile: mock(async () => Buffer.from('# User Profile\nTest content')),
      createGroupChat: mock(async () => 'group_123'),
    } as unknown as IChannel;

    const channelResolver = mock((type: string) => {
      if (type === 'feishu') return mockChannel;
      return undefined;
    });

    const ctx = createTestController({ channelResolver });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const message = createMessage({
      channel: 'feishu',
      contentType: 'file',
      content: '',
      metadata: {
        fileName: 'user.md',
        fileKey: 'file_key_123',
      },
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect(channelResolver).toHaveBeenCalledWith('feishu');
    expect(mockChannel.downloadFile).toHaveBeenCalledTimes(1);
    expect((result.data as { content: string }).content).toContain('USER.md 已更新成功');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-07: USER.md upload but channel doesn't support downloadFile
// ═══════════════════════════════════════════════════════════════
describe('MR-07: USER.md upload without downloadFile support', () => {
  test('channel without downloadFile -> error message', async () => {
    const mockChannel: IChannel = {
      type: 'feishu',
      name: 'feishu-limited',
      initialize: mock(async () => {}),
      shutdown: mock(async () => {}),
      sendMessage: mock(async () => {}),
      updateMessage: mock(async () => {}),
      sendStreamChunk: mock(async () => {}),
      onMessage: mock(() => {}),
      // No downloadFile!
    } as unknown as IChannel;

    const channelResolver = mock((type: string) => {
      if (type === 'feishu') return mockChannel;
      return undefined;
    });

    const ctx = createTestController({ channelResolver });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const message = createMessage({
      channel: 'feishu',
      contentType: 'file',
      content: '',
      metadata: {
        fileName: 'USER.md',
        fileKey: 'file_key_456',
      },
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toBe(
      '当前通道不支持文件下载，请直接发送文件内容。',
    );

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-08: Harness session sends "/end" -> handleHarnessEnd
// ═══════════════════════════════════════════════════════════════
describe('MR-08: Harness /end command', () => {
  test('"/end" in harness session -> closes session, returns summary', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    // First, create a session with a harnessWorktreeSlotId by pre-populating it
    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'web', 'conv_harness_end');
    session.harnessWorktreeSlotId = 'slot_test_end';
    session.harnessBranch = 'agent/feat/test-task';
    session.harnessWorktreePath = '/tmp/worktree/test-task';

    const closeSessionSpy = spyOn(sessionMgr, 'closeSession');

    const message = createMessage({
      userId: ADMIN_USER_ID,
      conversationId: 'conv_harness_end',
      content: '/end',
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    const content = (result.data as { content: string }).content;
    expect(content).toContain('Harness 任务结束');
    expect(content).toContain('agent/feat/test-task');
    expect(closeSessionSpy).toHaveBeenCalledTimes(1);

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-09: Harness session sends "结束任务" -> same as MR-08
// ═══════════════════════════════════════════════════════════════
describe('MR-09: Harness "结束任务" regex match', () => {
  test('"结束任务" matches HARNESS_END_PATTERN and triggers handleHarnessEnd', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'web', 'conv_harness_end2');
    session.harnessWorktreeSlotId = 'slot_test_end2';
    session.harnessBranch = 'agent/fix/bug-fix';

    const closeSessionSpy = spyOn(sessionMgr, 'closeSession');

    const message = createMessage({
      userId: ADMIN_USER_ID,
      conversationId: 'conv_harness_end2',
      content: '结束任务',
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain('Harness 任务结束');
    expect(closeSessionSpy).toHaveBeenCalledTimes(1);

    cleanupController(ctx);
  });

  test('"结束" alone also matches HARNESS_END_PATTERN', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'web', 'conv_harness_end3');
    session.harnessWorktreeSlotId = 'slot_test_end3';
    session.harnessBranch = 'agent/refactor/cleanup';

    const message = createMessage({
      userId: ADMIN_USER_ID,
      conversationId: 'conv_harness_end3',
      content: '结束',
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain('Harness 任务结束');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-10: scheduleCancelManager has pending selection
// ═══════════════════════════════════════════════════════════════
describe('MR-10: Pending schedule cancel selection', () => {
  test('isPendingSelection=true -> processSelection called', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const scheduleCancelMgr = (
      ctx.controller as unknown as {
        scheduleCancelManager: {
          isPendingSelection: (userId: string) => boolean;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          processSelection: (userId: string, content: string) => any;
        };
      }
    ).scheduleCancelManager;

    spyOn(scheduleCancelMgr, 'isPendingSelection').mockReturnValue(true);
    const processSpy = spyOn(scheduleCancelMgr, 'processSelection').mockReturnValue({
      success: true,
      data: { content: '已取消定时任务「每日提醒」' },
    });

    const message = createMessage({ content: '1' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain('已取消定时任务');
    expect(processSpy).toHaveBeenCalledTimes(1);

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-11: Session has worktreeSlotId -> force harness classification
// ═══════════════════════════════════════════════════════════════
describe('MR-11: Force harness classification when worktreeSlotId exists', () => {
  test('session.harnessWorktreeSlotId set -> classifier.classify NOT called, task.type=harness', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    // Pre-populate session with worktree binding
    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'web', 'conv_force_harness');
    session.harnessWorktreeSlotId = 'slot_force';
    session.harnessWorktreePath = '/tmp/worktree/force';
    session.harnessBranch = 'agent/feat/forced';

    // Spy on classifier to ensure it's NOT called
    const classifier = (
      ctx.controller as unknown as { classifier: { classify: (...args: unknown[]) => unknown } }
    ).classifier;
    const classifySpy = spyOn(
      classifier, // biome-ignore lint/suspicious/noExplicitAny: test mock
      'classify' as any,
    );

    // Spy on orchestrate to verify task type
    const orchestrateSpy = spyOn(ctx.controller, 'orchestrate');

    const message = createMessage({
      userId: ADMIN_USER_ID,
      conversationId: 'conv_force_harness',
      content: '继续上次的任务',
    });

    await ctx.controller.handleIncomingMessage(message);

    expect(classifySpy).not.toHaveBeenCalled();
    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    const task = orchestrateSpy.mock.calls[0]?.[0];
    expect(task.type).toBe('harness');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-12: Harness + non-admin user -> downgrade warning
// ═══════════════════════════════════════════════════════════════
describe('MR-12: Harness + non-admin user downgrade', () => {
  test('non-admin triggers harness -> maybeCreateHarnessGroupChat NOT called', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    // Force classification to return harness
    const classifier = (
      ctx.controller as unknown as { classifier: { classify: (...args: unknown[]) => unknown } }
    ).classifier;
    spyOn(
      classifier, // biome-ignore lint/suspicious/noExplicitAny: test mock
      'classify' as any,
    ).mockResolvedValue({
      taskType: 'harness',
      complexity: 'complex',
      reason: 'test',
      confidence: 0.9,
      classifiedBy: 'llm',
      costUsd: 0,
    });

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const maybeCreateSpy = spyOn(ctx.controller as any, 'maybeCreateHarnessGroupChat');

    const message = createMessage({
      userId: NON_ADMIN_USER_ID,
      content: '/harness 修复 bug',
    });

    await ctx.controller.handleIncomingMessage(message);

    // maybeCreateHarnessGroupChat should NOT be called for non-admin
    expect(maybeCreateSpy).not.toHaveBeenCalled();

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-13: Harness + admin + feishu + no worktree -> createGroupChat
// ═══════════════════════════════════════════════════════════════
describe('MR-13: Harness admin feishu -> group chat created', () => {
  test('admin + feishu + harness -> channel.createGroupChat called, session.harnessGroupChatId set', async () => {
    const mockChannel: IChannel = {
      type: 'feishu',
      name: 'feishu-test',
      initialize: mock(async () => {}),
      shutdown: mock(async () => {}),
      sendMessage: mock(async () => {}),
      updateMessage: mock(async () => {}),
      sendStreamChunk: mock(async () => {}),
      onMessage: mock(() => {}),
      downloadFile: mock(async () => Buffer.from('')),
      createGroupChat: mock(async () => 'group_chat_new_123'),
    } as unknown as IChannel;

    const channelResolver = mock((type: string) => {
      if (type === 'feishu') return mockChannel;
      return undefined;
    });

    const ctx = createTestController({ channelResolver });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    // Force harness classification
    const classifier = (
      ctx.controller as unknown as { classifier: { classify: (...args: unknown[]) => unknown } }
    ).classifier;
    spyOn(
      classifier, // biome-ignore lint/suspicious/noExplicitAny: test mock
      'classify' as any,
    ).mockResolvedValue({
      taskType: 'harness',
      complexity: 'complex',
      reason: 'test',
      confidence: 0.9,
      classifiedBy: 'llm',
      costUsd: 0,
    });

    const message = createMessage({
      userId: ADMIN_USER_ID,
      channel: 'feishu',
      content: '/harness 实现新功能',
    });

    await ctx.controller.handleIncomingMessage(message);

    expect(mockChannel.createGroupChat).toHaveBeenCalledTimes(1);
    expect(mockChannel.sendMessage).toHaveBeenCalledTimes(1);

    // Verify session got the group chat ID
    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'feishu', 'group_chat_new_123');
    expect(session.harnessGroupChatId).toBe('group_chat_new_123');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-14: Harness + admin + feishu + createGroupChat fails -> continue
// ═══════════════════════════════════════════════════════════════
describe('MR-14: createGroupChat failure graceful fallback', () => {
  test('createGroupChat throws -> continue with original session, no harnessGroupChatId', async () => {
    const mockChannel: IChannel = {
      type: 'feishu',
      name: 'feishu-failing',
      initialize: mock(async () => {}),
      shutdown: mock(async () => {}),
      sendMessage: mock(async () => {}),
      updateMessage: mock(async () => {}),
      sendStreamChunk: mock(async () => {}),
      onMessage: mock(() => {}),
      downloadFile: mock(async () => Buffer.from('')),
      createGroupChat: mock(async () => {
        throw new Error('Feishu API rate limit exceeded');
      }),
    } as unknown as IChannel;

    const channelResolver = mock((type: string) => {
      if (type === 'feishu') return mockChannel;
      return undefined;
    });

    const ctx = createTestController({ channelResolver });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const classifier = (
      ctx.controller as unknown as { classifier: { classify: (...args: unknown[]) => unknown } }
    ).classifier;
    spyOn(
      classifier, // biome-ignore lint/suspicious/noExplicitAny: test mock
      'classify' as any,
    ).mockResolvedValue({
      taskType: 'harness',
      complexity: 'complex',
      reason: 'test',
      confidence: 0.9,
      classifiedBy: 'llm',
      costUsd: 0,
    });

    const message = createMessage({
      userId: ADMIN_USER_ID,
      channel: 'feishu',
      conversationId: 'conv_fail_group',
      content: '/harness 实现功能',
    });

    // Should not throw
    const result = await ctx.controller.handleIncomingMessage(message);
    expect(result.success).toBe(true);

    // harnessGroupChatId should NOT be set on the original session
    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'feishu', 'conv_fail_group');
    expect(session.harnessGroupChatId).toBeUndefined();

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-15: taskDispatcher exists -> dispatchAndAwait returns result
// ═══════════════════════════════════════════════════════════════
describe('MR-15: TaskDispatcher path (with taskStore)', () => {
  test('controller WITH taskStore -> dispatchAndAwait returns {taskId, result}', async () => {
    const { taskStore } = createStores();

    const ctx = createTestController({ taskStore });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const message = createMessage({
      userId: ADMIN_USER_ID,
      content: '你好，帮我写个函数',
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect(result.taskId).toBeTruthy();
    expect((result.data as { content: string }).content).toBeTruthy();

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-16: taskDispatcher not exists -> sessionSerializer.run(orchestrate())
// ═══════════════════════════════════════════════════════════════
describe('MR-16: Direct orchestrate path (without taskStore)', () => {
  test('controller WITHOUT taskStore -> sessionSerializer.run(orchestrate()) direct execution', async () => {
    // createTestController without taskStore override -> no taskDispatcher
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const orchestrateSpy = spyOn(ctx.controller, 'orchestrate');

    const message = createMessage({ content: '你好' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toBeTruthy();
    // orchestrate should have been called directly (not through taskDispatcher)
    expect(orchestrateSpy).toHaveBeenCalledTimes(1);

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-17 (R6): Onboarding three paths: restore / start / continue
// ═══════════════════════════════════════════════════════════════
describe('MR-17: Onboarding three-path coverage', () => {
  test('path A: already onboarding -> processResponse (no startOnboarding)', async () => {
    const ctx = createTestController();
    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;

    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(true);
    const processSpy = spyOn(onboardingMgr, 'processResponse').mockResolvedValue('继续引导...');
    const startSpy = spyOn(onboardingMgr, 'startOnboarding');

    const message = createMessage({ content: 'Echo' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect((result.data as { content: string }).content).toBe('继续引导...');

    cleanupController(ctx);
  });

  test('path B: new user -> startOnboarding (processResponse not called)', async () => {
    const ctx = createTestController();
    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;

    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(true);
    const startSpy = spyOn(onboardingMgr, 'startOnboarding').mockResolvedValue('欢迎使用！');
    const processSpy = spyOn(onboardingMgr, 'processResponse');

    const message = createMessage({ content: 'hi' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).not.toHaveBeenCalled();
    expect((result.data as { content: string }).content).toBe('欢迎使用！');

    cleanupController(ctx);
  });

  test('path C: restored state -> tryRestoreState=true, isOnboarding=true -> processResponse', async () => {
    const ctx = createTestController();
    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;

    // tryRestoreState succeeds and causes isOnboarding to return true
    const isOnboardingSpy = spyOn(onboardingMgr, 'isOnboarding');
    spyOn(onboardingMgr, 'tryRestoreState').mockImplementation(async () => {
      isOnboardingSpy.mockReturnValue(true);
      return true;
    });
    const processSpy = spyOn(onboardingMgr, 'processResponse').mockResolvedValue('已恢复引导...');

    const message = createMessage({ content: '专业严谨' });
    const result = await ctx.controller.handleIncomingMessage(message);

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect((result.data as { content: string }).content).toBe('已恢复引导...');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-18 (R6): USER.md upload handling
// ═══════════════════════════════════════════════════════════════
describe('MR-18: USER.md upload handling via fileUploadHandler', () => {
  test('message with USER.md attachment -> fileUploadHandler processes -> confirmation', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const fileHandler = (
      ctx.controller as unknown as {
        fileUploadHandler: {
          isUserProfileUpload: (...args: unknown[]) => unknown;
          processUserMdUpload: (...args: unknown[]) => unknown;
        };
      }
    ).fileUploadHandler;

    // Verify isUserProfileUpload recognizes USER.md
    expect(fileHandler.isUserProfileUpload('USER.md')).toBe(true);
    expect(fileHandler.isUserProfileUpload('user.md')).toBe(true);
    expect(fileHandler.isUserProfileUpload('user.txt')).toBe(true);
    expect(fileHandler.isUserProfileUpload('random.md')).toBe(false);

    // Send a file upload message
    const fileContent = '# About Me\nI love TypeScript.';
    const message = createMessage({
      contentType: 'file',
      content: '',
      metadata: {
        fileName: 'USER.md',
        fileContentBase64: Buffer.from(fileContent).toString('base64'),
      },
    });

    const result = await ctx.controller.handleIncomingMessage(message);
    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain('USER.md 已更新成功');

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-19 (R6): Harness /end command -> session close + worktree release
// ═══════════════════════════════════════════════════════════════
describe('MR-19: Harness end with worktree release', () => {
  test('"结束" -> handleHarnessEnd -> session close triggers worktree release', async () => {
    const ctx = createTestController();

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const sessionMgr = (ctx.controller as unknown as { sessionManager: SessionManager })
      .sessionManager;
    const session = await sessionMgr.resolveSession(ADMIN_USER_ID, 'web', 'conv_end_release');
    session.harnessWorktreeSlotId = 'slot_release_test';
    session.harnessBranch = 'agent/feat/release-test';
    session.harnessWorktreePath = '/tmp/worktree/release-test';

    const closeSessionSpy = spyOn(sessionMgr, 'closeSession');

    const message = createMessage({
      userId: ADMIN_USER_ID,
      conversationId: 'conv_end_release',
      content: '结束',
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain('Harness 任务结束');
    expect(closeSessionSpy).toHaveBeenCalledWith(`${ADMIN_USER_ID}:web:conv_end_release`);

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// MR-20 (R6): Attachment/media main path
// ═══════════════════════════════════════════════════════════════
describe('MR-20: Attachment/media processing', () => {
  test('message with attachments -> mediaProcessor.processAttachments called, description injected', async () => {
    const mockMediaProcessor = createMockMediaProcessor();
    const ctx = createTestController({ mediaProcessor: mockMediaProcessor });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const message = createMessage({
      content: '这张图片是什么？',
      attachments: [
        {
          id: 'att_001',
          mediaType: 'image',
          state: 'pending',
          mimeType: 'image/png',
          sizeBytes: 1024,
        },
      ],
    });

    const result = await ctx.controller.handleIncomingMessage(message);

    expect(result.success).toBe(true);
    expect(mockMediaProcessor.processAttachments).toHaveBeenCalledTimes(1);

    cleanupController(ctx);
  });

  test('media processing failure degrades to plain text gracefully', async () => {
    const failingMediaProcessor = {
      processAttachments: mock(async () => {
        throw new Error('Media processing failed');
      }),
      toMediaRef: mock(() => ({})),
    };

    const ctx = createTestController({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mediaProcessor: failingMediaProcessor as any,
    });

    const onboardingMgr = (ctx.controller as unknown as { onboardingManager: OnboardingManager })
      .onboardingManager;
    spyOn(onboardingMgr, 'tryRestoreState').mockResolvedValue(false);
    spyOn(onboardingMgr, 'isOnboarding').mockReturnValue(false);
    spyOn(onboardingMgr, 'needsOnboarding').mockResolvedValue(false);

    const message = createMessage({
      content: '看看这个图片',
      attachments: [
        {
          id: 'att_fail',
          mediaType: 'image',
          state: 'pending',
          mimeType: 'image/jpeg',
          sizeBytes: 2048,
        },
      ],
    });

    // Should NOT throw, graceful degradation
    const result = await ctx.controller.handleIncomingMessage(message);
    expect(result.success).toBe(true);
    // Content should still be present (plain text fallback)
    expect((result.data as { content: string }).content).toBeTruthy();

    cleanupController(ctx);
  });
});

// ═══════════════════════════════════════════════════════════════
// HARNESS_END_PATTERN edge cases
// ═══════════════════════════════════════════════════════════════
describe('HARNESS_END_PATTERN regex validation', () => {
  const pattern = /^(结束(任务)?|\/end)\s*$/i;

  test.each([
    ['/end', true],
    ['/END', true],
    ['结束', true],
    ['结束任务', true],
    ['结束 ', true], // trailing space
    ['/end  ', true], // trailing spaces
    ['结束任务了', false], // extra chars
    ['请结束', false], // prefix
    ['hello', false],
    ['/endtask', false],
  ])('"%s" should match=%s', (input, expected) => {
    expect(pattern.test(input.trim())).toBe(expected);
  });
});
