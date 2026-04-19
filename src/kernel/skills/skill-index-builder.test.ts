import { describe, expect, test } from 'bun:test';
import type { SkillEntry } from './skill-index-builder';
import { SkillIndexBuilder } from './skill-index-builder';

function makeSkillMd(opts: {
  name: string;
  description: string;
  platforms?: string[];
  env?: string[];
}): string {
  const lines = ['---', `name: ${opts.name}`, `description: ${opts.description}`];
  if (opts.platforms?.length) {
    lines.push(`platforms: [${opts.platforms.join(', ')}]`);
  }
  if (opts.env?.length) {
    lines.push('readiness:');
    lines.push('  env:');
    for (const e of opts.env) {
      lines.push(`    - ${e}`);
    }
  }
  lines.push('---', '', '# Skill body');
  return lines.join('\n');
}

function createFileLoader(files: Record<string, string>): (path: string) => string | null {
  return (path: string) => files[path] ?? null;
}

describe('SkillIndexBuilder', () => {
  test('builds index with ready skills', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'commit', description: 'Git commit helper', dir: '/skills/commit' },
      { name: 'review-pr', description: 'PR review', dir: '/skills/review-pr' },
    ];

    const loadFile = createFileLoader({
      '/skills/commit/SKILL.md': makeSkillMd({ name: 'commit', description: 'Git commit' }),
      '/skills/review-pr/SKILL.md': makeSkillMd({
        name: 'review-pr',
        description: 'PR review',
      }),
    });

    const result = builder.build({ skills, loadFile });

    expect(result).toContain('# 可用 Skills');
    expect(result).toContain('**commit**: Git commit helper [✅]');
    expect(result).toContain('**review-pr**: PR review [✅]');
  });

  test('filters skills by platform', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'feishu-only', description: 'Feishu skill', dir: '/skills/feishu-only' },
      { name: 'universal', description: 'Universal skill', dir: '/skills/universal' },
    ];

    const loadFile = createFileLoader({
      '/skills/feishu-only/SKILL.md': makeSkillMd({
        name: 'feishu-only',
        description: 'Feishu skill',
        platforms: ['feishu'],
      }),
      '/skills/universal/SKILL.md': makeSkillMd({
        name: 'universal',
        description: 'Universal skill',
      }),
    });

    const result = builder.build({ skills, channel: 'telegram', loadFile });

    expect(result).not.toContain('feishu-only');
    expect(result).toContain('universal');
  });

  test('shows readiness status for skills with missing env', () => {
    process.env.MISSING_SKILL_KEY = undefined;
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'needs-env', description: 'Needs env', dir: '/skills/needs-env' },
    ];

    const loadFile = createFileLoader({
      '/skills/needs-env/SKILL.md': makeSkillMd({
        name: 'needs-env',
        description: 'Needs env',
        env: ['MISSING_SKILL_KEY'],
      }),
    });

    const result = builder.build({ skills, loadFile });

    expect(result).toContain('⚠️ 缺少: env:MISSING_SKILL_KEY');
  });

  test('shows ready status when env vars are present', () => {
    process.env.PRESENT_SKILL_KEY = 'value';
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'has-env', description: 'Has env', dir: '/skills/has-env' },
    ];

    const loadFile = createFileLoader({
      '/skills/has-env/SKILL.md': makeSkillMd({
        name: 'has-env',
        description: 'Has env',
        env: ['PRESENT_SKILL_KEY'],
      }),
    });

    const result = builder.build({ skills, loadFile });

    expect(result).toContain('[✅]');
    process.env.PRESENT_SKILL_KEY = undefined;
  });

  test('handles skills without SKILL.md (no frontmatter)', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'no-file', description: 'Missing file', dir: '/skills/no-file' },
    ];

    const loadFile = createFileLoader({});

    const result = builder.build({ skills, loadFile });

    // Should still include the skill (no frontmatter = no readiness = ready)
    expect(result).toContain('**no-file**: Missing file [✅]');
  });

  test('truncates output when exceeding budget', () => {
    const builder = new SkillIndexBuilder();

    // Create many skills to exceed a tiny budget
    const skills: SkillEntry[] = Array.from({ length: 50 }, (_, i) => ({
      name: `skill-${i}`,
      description: `This is a somewhat long description for skill number ${i} to fill space`,
      dir: `/skills/skill-${i}`,
    }));

    const loadFile = createFileLoader({});

    // Very small context window = very small budget
    const result = builder.build({ skills, contextWindowSize: 1000, loadFile });

    expect(result).toContain('更多 skills 因 token 预算限制省略');
    // Should not contain all 50 skills
    expect(result).not.toContain('skill-49');
  });

  test('uses default context window size', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [{ name: 'test', description: 'Test skill', dir: '/skills/test' }];

    const loadFile = createFileLoader({
      '/skills/test/SKILL.md': makeSkillMd({ name: 'test', description: 'Test' }),
    });

    // Should not throw and should use 200000 default
    const result = builder.build({ skills, loadFile });
    expect(result).toContain('**test**');
  });

  test('includes skill with matching platform', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'feishu-skill', description: 'Feishu skill', dir: '/skills/feishu-skill' },
    ];

    const loadFile = createFileLoader({
      '/skills/feishu-skill/SKILL.md': makeSkillMd({
        name: 'feishu-skill',
        description: 'Feishu skill',
        platforms: ['feishu', 'web'],
      }),
    });

    const result = builder.build({ skills, channel: 'feishu', loadFile });
    expect(result).toContain('feishu-skill');
  });

  test('includes all skills when no channel specified', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      { name: 'platform-skill', description: 'Has platforms', dir: '/skills/platform-skill' },
    ];

    const loadFile = createFileLoader({
      '/skills/platform-skill/SKILL.md': makeSkillMd({
        name: 'platform-skill',
        description: 'Has platforms',
        platforms: ['feishu'],
      }),
    });

    // No channel = include all
    const result = builder.build({ skills, loadFile });
    expect(result).toContain('platform-skill');
  });

  test('builds header even with empty skills list', () => {
    const builder = new SkillIndexBuilder();
    const result = builder.build({ skills: [], loadFile: () => null });

    expect(result).toContain('# 可用 Skills');
    expect(result).toContain('skill_view');
  });

  test('uses default fs loader when loadFile not provided (non-existent file)', () => {
    const builder = new SkillIndexBuilder();
    const skills: SkillEntry[] = [
      {
        name: 'missing-skill',
        description: 'Does not exist',
        dir: '/nonexistent/path/that/does/not/exist',
      },
    ];

    // No loadFile provided — falls through to fs.readFileSync which will throw
    const result = builder.build({ skills });

    // Should still include the skill (catch block returns null = no frontmatter = ready)
    expect(result).toContain('**missing-skill**: Does not exist [✅]');
  });
});
