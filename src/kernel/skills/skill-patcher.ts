import { Logger } from '../../shared/logging/logger';
import type { SkillManager } from './skill-manager';

const logger = new Logger('SkillPatcher');
const CONFIDENCE_THRESHOLD = 0.7;

export interface SkillPatch {
  action: 'create' | 'update';
  skillName: string;
  content: string; // SKILL.md content
  source: 'evolution';
  confidence: number; // 0-1
}

export interface PendingPatch extends SkillPatch {
  createdAt: number;
}

export interface SkillPatcherDeps {
  skillManager: SkillManager;
  workspaceDir: string;
}

/**
 * Receives SkillPatch from evolution/learning pipeline and applies them.
 * High-confidence patches (≥0.7) are auto-applied; low-confidence ones are stored as pending.
 */
export class SkillPatcher {
  private readonly skillManager: SkillManager;
  private readonly workspaceDir: string;
  private readonly pending: PendingPatch[] = [];

  constructor(deps: SkillPatcherDeps) {
    this.skillManager = deps.skillManager;
    this.workspaceDir = deps.workspaceDir;
  }

  async applyPatches(patches: SkillPatch[]): Promise<{ applied: string[]; deferred: string[] }> {
    const applied: string[] = [];
    const deferred: string[] = [];

    for (const patch of patches) {
      if (patch.confidence < CONFIDENCE_THRESHOLD) {
        this.pending.push({ ...patch, createdAt: Date.now() });
        deferred.push(patch.skillName);
        logger.info('低置信度 patch 延迟', {
          skillName: patch.skillName,
          confidence: patch.confidence,
        });
        continue;
      }

      this.skillManager.addSkill(this.workspaceDir, patch.skillName, {
        content: patch.content,
      });
      applied.push(patch.skillName);
      logger.info('Skill patch 已应用', {
        skillName: patch.skillName,
        action: patch.action,
        confidence: patch.confidence,
      });
    }

    return { applied, deferred };
  }

  getPendingPatches(): readonly PendingPatch[] {
    return this.pending;
  }

  /**
   * Manually approve a pending patch by skill name.
   */
  approvePending(skillName: string): boolean {
    const idx = this.pending.findIndex((p) => p.skillName === skillName);
    if (idx === -1) return false;

    const [patch] = this.pending.splice(idx, 1);
    if (!patch) return false;
    this.skillManager.addSkill(this.workspaceDir, patch.skillName, {
      content: patch.content,
    });
    logger.info('Pending patch 手动批准', { skillName });
    return true;
  }
}
