import { resolve } from 'node:path';
import { Logger } from '../../shared/logging/logger';
import type { DeployResult, SkillDeployerConfig } from './skill-types';

/**
 * File system operations interface for testability.
 */
export interface SkillFileOps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive: boolean }): void;
  cpSync(src: string, dest: string, options?: { recursive: boolean }): void;
  readdirSync(path: string): Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
  statSync(path: string): { isDirectory(): boolean };
}

export interface DeployContext {
  userId: string;
  tenantConfig?: {
    enabledSkills?: string[];
  };
}

const DEFAULT_BUILTIN_DIR = resolve(import.meta.dir, '../../../skills/builtin');
const DEFAULT_MARKETPLACE_DIR = '/opt/yourbot/skills/marketplace';

export class SkillDeployer {
  private readonly logger = new Logger('SkillDeployer');
  private readonly builtinSkillsDir: string;
  private readonly marketplaceSkillsDir: string;
  private readonly fs: SkillFileOps;

  constructor(config: SkillDeployerConfig, fileOps: SkillFileOps) {
    this.builtinSkillsDir = config.builtinSkillsDir ?? DEFAULT_BUILTIN_DIR;
    this.marketplaceSkillsDir = config.marketplaceSkillsDir ?? DEFAULT_MARKETPLACE_DIR;
    this.fs = fileOps;
  }

  /**
   * Deploy skill files to workspace's .claude/skills/ directory.
   * Each skill is a directory with SKILL.md as entrypoint.
   * Called once during workspace initialization.
   */
  deploy(workspaceDir: string, context: DeployContext): DeployResult {
    const skillsDir = `${workspaceDir}/.claude/skills`;
    this.fs.mkdirSync(skillsDir, { recursive: true });

    const result: DeployResult = { deployed: [], skipped: [], errors: [] };

    // 1. Deploy built-in skills
    this.deployFromDir(this.builtinSkillsDir, skillsDir, result);

    // 2. Deploy tenant-enabled marketplace skills
    for (const skillId of context.tenantConfig?.enabledSkills ?? []) {
      const skillPath = `${this.marketplaceSkillsDir}/${skillId}`;
      if (this.fs.existsSync(skillPath)) {
        this.deploySingleSkill(skillPath, skillsDir, result);
      } else {
        result.skipped.push(skillId);
      }
    }

    // 3. Deploy user custom skills
    const userSkillsDir = `/data/yourbot/user-skills/${context.userId}`;
    if (this.fs.existsSync(userSkillsDir)) {
      this.deployFromDir(userSkillsDir, skillsDir, result);
    }

    this.logger.info('技能部署完成', {
      deployed: result.deployed.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * Deploy all skills from a source directory.
   */
  private deployFromDir(sourceDir: string, targetDir: string, result: DeployResult): void {
    if (!this.fs.existsSync(sourceDir)) return;

    const entries = this.fs.readdirSync(sourceDir);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

      const sourcePath = `${sourceDir}/${entry.name}`;

      try {
        if (entry.isDirectory()) {
          // Skill directory: copy as-is
          this.deploySingleSkill(sourcePath, targetDir, result);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Legacy .md file: wrap into skill directory with SKILL.md
          const skillName = entry.name.replace('.md', '');
          const skillDir = `${targetDir}/${skillName}`;
          this.fs.mkdirSync(skillDir, { recursive: true });
          this.fs.cpSync(sourcePath, `${skillDir}/SKILL.md`);
          result.deployed.push(skillName);
        }
      } catch (error) {
        result.errors.push({
          skill: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Deploy a single skill directory.
   * Expects a directory with SKILL.md (or {skillName}.md) as entrypoint,
   * plus optional scripts/ and assets/ subdirectories.
   */
  private deploySingleSkill(sourcePath: string, targetDir: string, result: DeployResult): void {
    const skillName = sourcePath.split('/').pop() ?? '';

    try {
      if (!this.fs.statSync(sourcePath).isDirectory()) return;

      const skillDir = `${targetDir}/${skillName}`;
      this.fs.mkdirSync(skillDir, { recursive: true });

      // Look for SKILL.md or {skillName}.md
      const skillMdPath = this.fs.existsSync(`${sourcePath}/SKILL.md`)
        ? `${sourcePath}/SKILL.md`
        : `${sourcePath}/${skillName}.md`;

      if (this.fs.existsSync(skillMdPath)) {
        this.fs.cpSync(skillMdPath, `${skillDir}/SKILL.md`);
      }

      // Copy resource directories (scripts/ + assets/)
      const scriptsDir = `${sourcePath}/scripts`;
      const assetsDir = `${sourcePath}/assets`;

      if (this.fs.existsSync(scriptsDir)) {
        this.fs.cpSync(scriptsDir, `${skillDir}/scripts`, { recursive: true });
      }
      if (this.fs.existsSync(assetsDir)) {
        this.fs.cpSync(assetsDir, `${skillDir}/assets`, { recursive: true });
      }

      result.deployed.push(skillName);
    } catch (error) {
      result.errors.push({
        skill: skillName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
