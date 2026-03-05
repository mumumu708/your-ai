import { describe, expect, test } from 'bun:test';
import { SkillDeployer, type SkillFileOps } from './skill-deployer';

type Entry = { name: string; isFile(): boolean; isDirectory(): boolean };

function createMockFs(
  files: Record<string, boolean>, // path -> exists
  dirs: Record<string, Entry[]> = {}, // path -> entries
  extraDirs: string[] = [], // additional paths that are directories (for statSync)
): { fs: SkillFileOps; copied: Array<{ src: string; dest: string }>; mkdirs: string[] } {
  const copied: Array<{ src: string; dest: string }> = [];
  const mkdirs: string[] = [];
  const isDirSet = new Set<string>();

  // Mark directories from dirs entries and extraDirs
  for (const path of Object.keys(dirs)) {
    isDirSet.add(path);
    files[path] = true;
  }
  for (const path of extraDirs) {
    isDirSet.add(path);
  }

  const fs: SkillFileOps = {
    existsSync: (path) => files[path] ?? false,
    mkdirSync: (path) => {
      mkdirs.push(path);
    },
    cpSync: (src, dest) => {
      copied.push({ src, dest });
    },
    readdirSync: (path) => dirs[path] ?? [],
    statSync: (path) => ({
      isDirectory: () => isDirSet.has(path),
    }),
  };

  return { fs, copied, mkdirs };
}

function fileEntry(name: string): Entry {
  return { name, isFile: () => true, isDirectory: () => false };
}

function dirEntry(name: string): Entry {
  return { name, isFile: () => false, isDirectory: () => true };
}

describe('SkillDeployer', () => {
  test('should deploy basic skills from builtin directory as skill directories', () => {
    const { fs, copied, mkdirs } = createMockFs(
      {
        '/builtin': true,
        '/builtin/commit.md': true,
        '/builtin/review-pr.md': true,
      },
      {
        '/builtin': [fileEntry('commit.md'), fileEntry('review-pr.md')],
      },
    );

    const deployer = new SkillDeployer({ builtinSkillsDir: '/builtin' }, fs);
    const result = deployer.deploy('/workspace', { userId: 'user_001' });

    expect(mkdirs).toContain('/workspace/.claude/skills');
    // Legacy .md files get wrapped into skill directories
    expect(mkdirs).toContain('/workspace/.claude/skills/commit');
    expect(mkdirs).toContain('/workspace/.claude/skills/review-pr');
    expect(result.deployed).toContain('commit');
    expect(result.deployed).toContain('review-pr');
    // Each .md file is copied as SKILL.md inside its directory
    expect(copied.some((c) => c.dest === '/workspace/.claude/skills/commit/SKILL.md')).toBe(true);
    expect(copied.some((c) => c.dest === '/workspace/.claude/skills/review-pr/SKILL.md')).toBe(
      true,
    );
  });

  test('should deploy advanced skills with resource directories', () => {
    const { fs, copied, mkdirs } = createMockFs(
      {
        '/builtin': true,
        '/builtin/deploy-staging': true,
        '/builtin/deploy-staging/SKILL.md': true,
        '/builtin/deploy-staging/scripts': true,
        '/builtin/deploy-staging/assets': true,
      },
      {
        '/builtin': [dirEntry('deploy-staging')],
      },
      ['/builtin/deploy-staging'],
    );

    const deployer = new SkillDeployer({ builtinSkillsDir: '/builtin' }, fs);
    const result = deployer.deploy('/workspace', { userId: 'user_001' });

    expect(result.deployed).toContain('deploy-staging');
    // Should create skill directory
    expect(mkdirs).toContain('/workspace/.claude/skills/deploy-staging');
    // Should copy SKILL.md, scripts, assets
    expect(copied.some((c) => c.dest.endsWith('deploy-staging/SKILL.md'))).toBe(true);
    expect(copied.some((c) => c.dest.endsWith('/scripts'))).toBe(true);
    expect(copied.some((c) => c.dest.endsWith('/assets'))).toBe(true);
  });

  test('should deploy marketplace skills from tenant config', () => {
    const { fs, copied: _copied } = createMockFs(
      {
        '/marketplace/code-review-pro': true,
        '/marketplace/code-review-pro/SKILL.md': true,
      },
      {},
      ['/marketplace/code-review-pro'],
    );

    const deployer = new SkillDeployer(
      { builtinSkillsDir: '/nonexistent', marketplaceSkillsDir: '/marketplace' },
      fs,
    );
    const result = deployer.deploy('/workspace', {
      userId: 'user_001',
      tenantConfig: { enabledSkills: ['code-review-pro', 'missing-skill'] },
    });

    expect(result.deployed).toContain('code-review-pro');
    expect(result.skipped).toContain('missing-skill');
  });

  test('should deploy user custom skills', () => {
    const { fs, copied: _copied } = createMockFs(
      {
        '/data/yourbot/user-skills/user_001': true,
        '/data/yourbot/user-skills/user_001/my-tool.md': true,
      },
      {
        '/data/yourbot/user-skills/user_001': [fileEntry('my-tool.md')],
      },
    );

    const deployer = new SkillDeployer({ builtinSkillsDir: '/nonexistent' }, fs);
    const result = deployer.deploy('/workspace', { userId: 'user_001' });

    expect(result.deployed).toContain('my-tool');
  });

  test('should skip hidden files and underscore prefixed files', () => {
    const { fs } = createMockFs(
      {
        '/builtin': true,
        '/builtin/.hidden.md': true,
        '/builtin/_draft.md': true,
        '/builtin/valid.md': true,
      },
      {
        '/builtin': [fileEntry('.hidden.md'), fileEntry('_draft.md'), fileEntry('valid.md')],
      },
    );

    const deployer = new SkillDeployer({ builtinSkillsDir: '/builtin' }, fs);
    const result = deployer.deploy('/workspace', { userId: 'user_001' });

    expect(result.deployed).toEqual(['valid']);
  });

  test('should handle errors gracefully', () => {
    const fs: SkillFileOps = {
      existsSync: (path) => path === '/builtin' || path === '/builtin/broken.md',
      mkdirSync: () => {},
      cpSync: () => {
        throw new Error('Permission denied');
      },
      readdirSync: () => [fileEntry('broken.md')],
      statSync: () => ({ isDirectory: () => false }),
    };

    const deployer = new SkillDeployer({ builtinSkillsDir: '/builtin' }, fs);
    const result = deployer.deploy('/workspace', { userId: 'user_001' });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].skill).toBe('broken.md');
    expect(result.errors[0].error).toContain('Permission denied');
  });

  test('should use {skillName}.md fallback when SKILL.md not found', () => {
    const { fs, copied } = createMockFs(
      {
        '/builtin': true,
        '/builtin/my-deploy': true,
        '/builtin/my-deploy/my-deploy.md': true,
      },
      {
        '/builtin': [dirEntry('my-deploy')],
      },
      ['/builtin/my-deploy'],
    );

    const deployer = new SkillDeployer({ builtinSkillsDir: '/builtin' }, fs);
    const result = deployer.deploy('/workspace', { userId: 'user_001' });

    expect(result.deployed).toContain('my-deploy');
    // Fallback .md is copied as SKILL.md in the skill directory
    expect(copied.some((c) => c.src.endsWith('my-deploy.md') && c.dest.endsWith('SKILL.md'))).toBe(
      true,
    );
  });
});
