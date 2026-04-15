import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { SkillManager } from './skill-manager';
import { type SkillPatch, SkillPatcher } from './skill-patcher';

function createMockSkillManager(): SkillManager {
  return {
    addSkill: mock(() => ({ command: 'ok' })),
    removeSkill: mock(() => true),
    getSkill: mock(() => null),
    listSkills: mock(() => []),
  } as unknown as SkillManager;
}

describe('SkillPatcher', () => {
  let patcher: SkillPatcher;
  let skillManager: SkillManager;

  beforeEach(() => {
    skillManager = createMockSkillManager();
    patcher = new SkillPatcher({
      skillManager,
      workspaceDir: '/test/workspace',
    });
    spyOn(console, 'log').mockImplementation(() => {});
  });

  test('confidence ≥ 0.7 的 patch 自动执行', async () => {
    const patches: SkillPatch[] = [
      {
        action: 'create',
        skillName: 'debug-ts',
        content: '---\nname: debug-ts\n---\nTS 调试技能',
        source: 'evolution',
        confidence: 0.8,
      },
    ];

    const result = await patcher.applyPatches(patches);
    expect(result.applied).toEqual(['debug-ts']);
    expect(result.deferred).toEqual([]);
    expect(skillManager.addSkill).toHaveBeenCalledWith('/test/workspace', 'debug-ts', {
      content: '---\nname: debug-ts\n---\nTS 调试技能',
    });
  });

  test('confidence < 0.7 的 patch 存为 pending', async () => {
    const patches: SkillPatch[] = [
      {
        action: 'create',
        skillName: 'low-conf',
        content: 'low confidence skill',
        source: 'evolution',
        confidence: 0.5,
      },
    ];

    const result = await patcher.applyPatches(patches);
    expect(result.applied).toEqual([]);
    expect(result.deferred).toEqual(['low-conf']);
    expect(skillManager.addSkill).not.toHaveBeenCalled();
    expect(patcher.getPendingPatches()).toHaveLength(1);
    expect(patcher.getPendingPatches()[0]!.skillName).toBe('low-conf');
  });

  test('混合 confidence 的 patches 正确分流', async () => {
    const patches: SkillPatch[] = [
      { action: 'create', skillName: 'high', content: 'h', source: 'evolution', confidence: 0.9 },
      { action: 'create', skillName: 'low', content: 'l', source: 'evolution', confidence: 0.3 },
      { action: 'update', skillName: 'mid', content: 'm', source: 'evolution', confidence: 0.7 },
    ];

    const result = await patcher.applyPatches(patches);
    expect(result.applied).toEqual(['high', 'mid']);
    expect(result.deferred).toEqual(['low']);
  });

  test('approvePending 批准 pending patch', async () => {
    await patcher.applyPatches([
      { action: 'create', skillName: 'pending-one', content: 'p', source: 'evolution', confidence: 0.4 },
    ]);

    expect(patcher.getPendingPatches()).toHaveLength(1);

    const approved = patcher.approvePending('pending-one');
    expect(approved).toBe(true);
    expect(patcher.getPendingPatches()).toHaveLength(0);
    expect(skillManager.addSkill).toHaveBeenCalledWith('/test/workspace', 'pending-one', {
      content: 'p',
    });
  });

  test('approvePending 不存在的 skill 返回 false', () => {
    expect(patcher.approvePending('nonexistent')).toBe(false);
  });

  test('空 patches 数组不报错', async () => {
    const result = await patcher.applyPatches([]);
    expect(result.applied).toEqual([]);
    expect(result.deferred).toEqual([]);
  });
});
