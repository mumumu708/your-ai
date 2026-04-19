import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LightLLMClient } from '../agents/light-llm-client';
import type { UserConfigLoader } from '../prompt/user-config-loader';
import { OnboardingManager } from './onboarding-manager';

function createMockUserConfigLoader(): UserConfigLoader {
  return {
    hasUserConfig: mock(async () => false),
    writeConfig: mock(async () => {}),
    invalidateCache: mock(() => {}),
    getLocalDir: mock(() => '/tmp/test-user/memory'),
    loadAll: mock(async () => ({ soul: '', identity: '', user: '', agents: '' })),
  } as unknown as UserConfigLoader;
}

function createMockLLM(): LightLLMClient {
  return {
    complete: mock(async () => ({
      content: JSON.stringify({
        soul: '# Generated Soul',
        identity: '# Generated Identity',
      }),
    })),
  } as unknown as LightLLMClient;
}

describe('OnboardingManager', () => {
  let bunFileSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    if (bunFileSpy) bunFileSpy.mockRestore();
  });

  // ─── needsOnboarding ─────────────────────────────────
  test('returns true when no SOUL.md exists', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    expect(await mgr.needsOnboarding(ucl)).toBe(true);
  });

  test('returns false when SOUL.md exists', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    (ucl.hasUserConfig as ReturnType<typeof mock>).mockResolvedValue(true);
    expect(await mgr.needsOnboarding(ucl)).toBe(false);
  });

  // ─── isOnboarding ────────────────────────────────────
  test('returns false for unknown user', () => {
    const mgr = new OnboardingManager(null);
    expect(mgr.isOnboarding('user1')).toBe(false);
  });

  // ─── startOnboarding ─────────────────────────────────
  test('starts onboarding and returns first prompt', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    const prompt = await mgr.startOnboarding('user1', ucl);
    expect(prompt).toContain('名字');
    expect(mgr.isOnboarding('user1')).toBe(true);
  });

  // ─── processResponse: full flow ──────────────────────
  test('completes full onboarding flow without LLM', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();

    // unlinkSync mock for removeBootstrapFile
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () => ({ exists: async () => false }) as unknown as ReturnType<typeof Bun.file>,
    );

    await mgr.startOnboarding('user1', ucl);

    // Step 1: agent_name
    const r1 = await mgr.processResponse('user1', 'Nova', ucl);
    expect(r1).toContain('Nova');
    expect(r1).toContain('风格');

    // Step 2: personality
    const r2 = await mgr.processResponse('user1', '简洁高效', ucl);
    expect(r2).toContain('简洁高效');
    expect(r2).toContain('原则');

    // Step 3: values
    const r3 = await mgr.processResponse('user1', '准确性第一', ucl);
    expect(r3).toContain('预览');

    // Step 4: confirm
    const r4 = await mgr.processResponse('user1', '是', ucl);
    expect(r4).toContain('完成');
    expect(mgr.isOnboarding('user1')).toBe(false);
    expect(ucl.writeConfig).toHaveBeenCalled();
  });

  test('restarts when user rejects in confirm step', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Nova', ucl);
    await mgr.processResponse('user1', '简洁', ucl);
    await mgr.processResponse('user1', '准确', ucl);

    const r = await mgr.processResponse('user1', '否', ucl);
    expect(r).toContain('重新');
  });

  test('uses default values for empty inputs', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    const r1 = await mgr.processResponse('user1', '', ucl);
    expect(r1).toContain('AI 助手');
    const r2 = await mgr.processResponse('user1', '', ucl);
    expect(r2).toContain('专业且友好');
    await mgr.processResponse('user1', '', ucl);
    const r4 = await mgr.processResponse('user1', '是', ucl);
    expect(r4).toContain('完成');
  });

  test('returns expired message for unknown state', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    const r = await mgr.processResponse('unknown', 'hello', ucl);
    expect(r).toContain('过期');
  });

  // ─── LLM integration ─────────────────────────────────
  test('uses LLM to generate configs when available', async () => {
    const llm = createMockLLM();
    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Nova', ucl);
    await mgr.processResponse('user1', '幽默', ucl);
    await mgr.processResponse('user1', '创新', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
    expect(llm.complete).toHaveBeenCalled();
  });

  test('falls back to template when LLM returns invalid JSON', async () => {
    const llm = createMockLLM();
    (llm.complete as ReturnType<typeof mock>).mockResolvedValue({ content: 'not json' });
    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Echo', ucl);
    await mgr.processResponse('user1', '温暖', ucl);
    await mgr.processResponse('user1', '隐私', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });

  test('falls back to template when LLM throws', async () => {
    const llm = createMockLLM();
    (llm.complete as ReturnType<typeof mock>).mockRejectedValue(new Error('LLM down'));
    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Echo', ucl);
    await mgr.processResponse('user1', '简洁', ucl);
    await mgr.processResponse('user1', '准确', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });

  test('falls back when LLM returns empty soul/identity', async () => {
    const llm = createMockLLM();
    (llm.complete as ReturnType<typeof mock>).mockResolvedValue({
      content: JSON.stringify({ soul: '', identity: '' }),
    });
    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Bot', ucl);
    await mgr.processResponse('user1', 'Friendly', ucl);
    await mgr.processResponse('user1', 'Accurate', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });

  test('extracts JSON from markdown code fences', async () => {
    const llm = createMockLLM();
    (llm.complete as ReturnType<typeof mock>).mockResolvedValue({
      content: '```json\n{"soul": "# Soul", "identity": "# Identity"}\n```',
    });
    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Bot', ucl);
    await mgr.processResponse('user1', 'Friendly', ucl);
    await mgr.processResponse('user1', 'Accurate', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });

  // ─── tryRestoreState ─────────────────────────────────
  test('restores state from BOOTSTRAP.md', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    const state = {
      userId: 'user1',
      step: 'personality',
      agentName: 'Nova',
      personality: '',
      values: '',
      createdAt: Date.now(),
    };

    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => true,
          text: async () => JSON.stringify(state),
        }) as unknown as ReturnType<typeof Bun.file>,
    );

    const restored = await mgr.tryRestoreState('user1', ucl);
    expect(restored).toBe(true);
    expect(mgr.isOnboarding('user1')).toBe(true);
  });

  test('returns true if state already exists', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    await mgr.startOnboarding('user1', ucl);
    expect(await mgr.tryRestoreState('user1')).toBe(true);
  });

  test('returns false when no bootstrap file', async () => {
    const mgr = new OnboardingManager(null);
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(
      () => ({ exists: async () => false }) as unknown as ReturnType<typeof Bun.file>,
    );
    expect(await mgr.tryRestoreState('user1')).toBe(false);
  });

  test('handles errors in tryRestoreState', async () => {
    const mgr = new OnboardingManager(null);
    bunFileSpy = spyOn(Bun, 'file').mockImplementation(() => {
      throw new Error('fs error');
    });
    expect(await mgr.tryRestoreState('user1')).toBe(false);
  });

  // ─── resetUser ───────────────────────────────────────
  test('resets user state', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    await mgr.startOnboarding('user1', ucl);
    expect(mgr.isOnboarding('user1')).toBe(true);
    mgr.resetUser('user1');
    expect(mgr.isOnboarding('user1')).toBe(false);
  });

  // ─── persistState error handling ─────────────────────
  test('handles persistState failure gracefully', async () => {
    const mgr = new OnboardingManager(null);
    const ucl = createMockUserConfigLoader();
    (ucl.writeConfig as ReturnType<typeof mock>).mockRejectedValue(new Error('write failed'));

    // Should not throw
    const prompt = await mgr.startOnboarding('user1', ucl);
    expect(prompt).toContain('名字');
  });

  // ─── generateWithTranslation ──────────────────────────
  test('translates templates when LLM available', async () => {
    const llm = createMockLLM();
    // First call: config generation fails to get JSON
    // Second & third calls: translations succeed
    let callCount = 0;
    (llm.complete as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { content: 'not json at all' };
      return { content: 'Translated content' };
    });

    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Bot', ucl);
    await mgr.processResponse('user1', '温暖', ucl);
    await mgr.processResponse('user1', '隐私', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });

  test('falls back to original when translation LLM returns empty', async () => {
    const llm = createMockLLM();
    let callCount = 0;
    (llm.complete as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('LLM fail');
      return { content: '' }; // Empty translation
    });

    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Bot', ucl);
    await mgr.processResponse('user1', '简洁', ucl);
    await mgr.processResponse('user1', '准确', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });

  test('falls back to original when translation LLM throws', async () => {
    const llm = createMockLLM();
    (llm.complete as ReturnType<typeof mock>).mockRejectedValue(new Error('LLM down'));

    const mgr = new OnboardingManager(llm);
    const ucl = createMockUserConfigLoader();

    await mgr.startOnboarding('user1', ucl);
    await mgr.processResponse('user1', 'Bot', ucl);
    await mgr.processResponse('user1', '简洁', ucl);
    await mgr.processResponse('user1', '准确', ucl);
    const r = await mgr.processResponse('user1', '是', ucl);
    expect(r).toContain('完成');
  });
});
