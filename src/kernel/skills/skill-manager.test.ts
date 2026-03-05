import { describe, expect, test } from 'bun:test';
import { SkillManager, type SkillManagerFileOps } from './skill-manager';

type Entry = { name: string; isFile(): boolean; isDirectory(): boolean };

function createMockFs(): {
  fs: SkillManagerFileOps;
  files: Map<string, string>;
  dirs: Set<string>;
  removed: string[];
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const removed: string[] = [];

  const fs: SkillManagerFileOps = {
    existsSync: (path) => files.has(path) || dirs.has(path),
    mkdirSync: (path) => {
      dirs.add(path);
    },
    writeFileSync: (path, content) => {
      files.set(path, content);
    },
    unlinkSync: (path) => {
      files.delete(path);
      removed.push(path);
    },
    rmSync: (path) => {
      dirs.delete(path);
      removed.push(path);
    },
    readFileSync: (path) => files.get(path) ?? '',
    readdirSync: (path) => {
      const entries: Entry[] = [];
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const seen = new Set<string>();
      // List immediate children (files and directories)
      for (const [filePath] of files) {
        if (filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length);
          const name = rest.split('/')[0];
          if (!seen.has(name)) {
            seen.add(name);
            const isDir = rest.includes('/');
            entries.push({
              name,
              isFile: () => !isDir,
              isDirectory: () => isDir,
            });
          }
        }
      }
      for (const dirPath of dirs) {
        if (dirPath.startsWith(prefix)) {
          const rest = dirPath.slice(prefix.length);
          const name = rest.split('/')[0];
          if (!seen.has(name) && !rest.includes('/')) {
            seen.add(name);
            entries.push({
              name,
              isFile: () => false,
              isDirectory: () => true,
            });
          }
        }
      }
      return entries;
    },
  };

  return { fs, files, dirs, removed };
}

describe('SkillManager', () => {
  test('should add a basic skill as skill directory with SKILL.md', () => {
    const { fs, files } = createMockFs();
    const manager = new SkillManager(fs);

    const result = manager.addSkill('/ws', 'commit', {
      content: '# Git Commit\nGenerate commit message',
    });

    expect(result.command).toBe('/commit');
    expect(files.has('/ws/.claude/skills/commit/SKILL.md')).toBe(true);
    expect(files.get('/ws/.claude/skills/commit/SKILL.md')).toContain('Git Commit');
  });

  test('should add an advanced skill with scripts and assets', () => {
    const { fs, files, dirs } = createMockFs();
    const manager = new SkillManager(fs);

    manager.addSkill('/ws', 'deploy', {
      content: '# Deploy\nDeploy to staging',
      scripts: { 'deploy.sh': '#!/bin/bash\necho deploy' },
      assets: { 'k8s.yaml': 'apiVersion: v1' },
    });

    expect(files.has('/ws/.claude/skills/deploy/SKILL.md')).toBe(true);
    expect(files.has('/ws/.claude/skills/deploy/scripts/deploy.sh')).toBe(true);
    expect(files.has('/ws/.claude/skills/deploy/assets/k8s.yaml')).toBe(true);
    expect(dirs.has('/ws/.claude/skills/deploy/scripts')).toBe(true);
    expect(dirs.has('/ws/.claude/skills/deploy/assets')).toBe(true);
  });

  test('should remove a skill directory', () => {
    const { fs, dirs, removed } = createMockFs();
    dirs.add('/ws/.claude/skills/old-skill');

    const manager = new SkillManager(fs);
    const result = manager.removeSkill('/ws', 'old-skill');

    expect(result).toBe(true);
    expect(removed).toContain('/ws/.claude/skills/old-skill');
  });

  test('should list all skills', () => {
    const { fs, files, dirs } = createMockFs();
    files.set('/ws/.claude/skills/commit/SKILL.md', '# Commit');
    files.set('/ws/.claude/skills/review-pr/SKILL.md', '# Review');
    files.set('/ws/.claude/skills/deploy/SKILL.md', '# Deploy');
    files.set('/ws/.claude/skills/deploy/scripts/deploy.sh', '#!/bin/bash');
    dirs.add('/ws/.claude/skills');
    dirs.add('/ws/.claude/skills/deploy/scripts');

    const manager = new SkillManager(fs);
    const skills = manager.listSkills('/ws');

    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name);
    expect(names).toContain('commit');
    expect(names).toContain('review-pr');
    expect(names).toContain('deploy');

    const deploy = skills.find((s) => s.name === 'deploy');
    if (!deploy) throw new Error('Expected to find deploy skill');
    expect(deploy.tier).toBe('advanced');
    expect(deploy.command).toBe('/deploy');

    const commit = skills.find((s) => s.name === 'commit');
    if (!commit) throw new Error('Expected to find commit skill');
    expect(commit.tier).toBe('basic');
  });

  test('should return empty list when skills dir missing', () => {
    const { fs } = createMockFs();
    const manager = new SkillManager(fs);
    const skills = manager.listSkills('/ws');
    expect(skills).toEqual([]);
  });

  test('should get skill content', () => {
    const { fs, files } = createMockFs();
    files.set('/ws/.claude/skills/commit/SKILL.md', '# Commit\nDo the commit');

    const manager = new SkillManager(fs);
    const content = manager.getSkillContent('/ws', 'commit');
    expect(content).toBe('# Commit\nDo the commit');
  });

  test('should return null for missing skill content', () => {
    const { fs } = createMockFs();
    const manager = new SkillManager(fs);
    expect(manager.getSkillContent('/ws', 'nonexistent')).toBeNull();
  });

  test('should check skill existence', () => {
    const { fs, files } = createMockFs();
    files.set('/ws/.claude/skills/commit/SKILL.md', '# Commit');

    const manager = new SkillManager(fs);
    expect(manager.hasSkill('/ws', 'commit')).toBe(true);
    expect(manager.hasSkill('/ws', 'nonexistent')).toBe(false);
  });
});
