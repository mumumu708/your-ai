import { Logger } from '../../shared/logging/logger';
import type { SkillContent, SkillInfo } from './skill-types';

/**
 * File system operations for skill management.
 */
export interface SkillManagerFileOps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive: boolean }): void;
  writeFileSync(path: string, content: string): void;
  unlinkSync(path: string): void;
  rmSync(path: string, options?: { recursive: boolean }): void;
  readFileSync(path: string): string;
  readdirSync(path: string): Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
}

/**
 * Runtime skill CRUD operations.
 * Skills are stored as .claude/skills/{name}/SKILL.md directories.
 * Changes take effect immediately via Claude Code's native file change detection.
 */
export class SkillManager {
  private readonly logger = new Logger('SkillManager');
  private readonly fs: SkillManagerFileOps;

  constructor(fileOps: SkillManagerFileOps) {
    this.fs = fileOps;
  }

  /**
   * Add a skill to a workspace.
   */
  addSkill(workspaceDir: string, skillName: string, skill: SkillContent): { command: string } {
    const skillDir = `${workspaceDir}/.claude/skills/${skillName}`;
    this.fs.mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md entrypoint
    this.fs.writeFileSync(`${skillDir}/SKILL.md`, skill.content);

    // Write resource files if present
    if (skill.scripts) {
      const scriptsDir = `${skillDir}/scripts`;
      this.fs.mkdirSync(scriptsDir, { recursive: true });
      for (const [name, content] of Object.entries(skill.scripts)) {
        this.fs.writeFileSync(`${scriptsDir}/${name}`, content);
      }
    }

    if (skill.assets) {
      const assetsDir = `${skillDir}/assets`;
      this.fs.mkdirSync(assetsDir, { recursive: true });
      for (const [name, content] of Object.entries(skill.assets)) {
        this.fs.writeFileSync(`${assetsDir}/${name}`, content);
      }
    }

    this.logger.info('技能添加', { skillName, command: `/${skillName}` });
    return { command: `/${skillName}` };
  }

  /**
   * Remove a skill from a workspace.
   */
  removeSkill(workspaceDir: string, skillName: string): boolean {
    const skillDir = `${workspaceDir}/.claude/skills/${skillName}`;

    if (this.fs.existsSync(skillDir)) {
      this.fs.rmSync(skillDir, { recursive: true });
    }

    this.logger.info('技能删除', { skillName });
    return true;
  }

  /**
   * List all skills in a workspace.
   */
  listSkills(workspaceDir: string): SkillInfo[] {
    const skillsDir = `${workspaceDir}/.claude/skills`;

    if (!this.fs.existsSync(skillsDir)) {
      return [];
    }

    const entries = this.fs.readdirSync(skillsDir);
    const skills: SkillInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillName = entry.name;
      const hasSkillMd = this.fs.existsSync(`${skillsDir}/${skillName}/SKILL.md`);
      if (!hasSkillMd) continue;

      const hasScripts = this.fs.existsSync(`${skillsDir}/${skillName}/scripts`);
      const hasAssets = this.fs.existsSync(`${skillsDir}/${skillName}/assets`);

      skills.push({
        name: skillName,
        command: `/${skillName}`,
        tier: hasScripts || hasAssets ? 'advanced' : 'basic',
        source: 'custom',
      });
    }

    return skills;
  }

  /**
   * Read a skill's content.
   */
  getSkillContent(workspaceDir: string, skillName: string): string | null {
    const skillMdPath = `${workspaceDir}/.claude/skills/${skillName}/SKILL.md`;
    if (!this.fs.existsSync(skillMdPath)) return null;
    return this.fs.readFileSync(skillMdPath);
  }

  /**
   * Check if a skill exists.
   */
  hasSkill(workspaceDir: string, skillName: string): boolean {
    return this.fs.existsSync(`${workspaceDir}/.claude/skills/${skillName}/SKILL.md`);
  }
}
