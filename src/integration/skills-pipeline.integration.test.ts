/**
 * 集成测试: Skills 执行管道
 *
 * 测试完整的 skill 生命周期:
 *   skill-frontmatter 解析 → skill-readiness 检查 → skill-index-builder 索引生成 → skill-deployer 部署
 *
 * Mock: 文件系统操作
 * 验证: 技能注册、就绪检查、索引生成、部署的端到端流程
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { type SkillFileOps, SkillDeployer } from '../kernel/skills/skill-deployer';
import { parseFrontmatter } from '../kernel/skills/skill-frontmatter';
import { SkillIndexBuilder, type SkillEntry } from '../kernel/skills/skill-index-builder';
import { SkillManager, type SkillManagerFileOps } from '../kernel/skills/skill-manager';
import { checkReadiness } from '../kernel/skills/skill-readiness';

// ── Test helpers ──────────────────────────────────────────

const SKILL_MD_DEPLOY = `---
name: deploy-staging
description: 部署到 staging 环境
version: "1.0"
platforms: [feishu, web]
readiness:
  env:
    - DEPLOY_TOKEN
---

# Deploy Staging

执行 staging 部署流程。`;

const SKILL_MD_RSS = `---
name: rss-digest
description: RSS 订阅摘要
version: "2.1"
author: admin
readiness:
  env:
    - RSS_API_KEY
metadata:
  tags:
    - automation
    - digest
---

# RSS Digest

自动聚合 RSS 源。`;

const SKILL_MD_NO_DEPS = `---
name: hello-world
description: 简单问候
version: "1.0"
---

# Hello World

一个不需要外部依赖的简单技能。`;

/** In-memory filesystem mock for SkillDeployer */
function createMockDeployerFs(): SkillFileOps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const isDir = (path: string) =>
    dirs.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`));

  return {
    files,
    existsSync: mock((path: string) => files.has(path) || isDir(path)),
    mkdirSync: mock((path: string) => {
      dirs.add(path);
    }),
    cpSync: mock((src: string, dest: string) => {
      const content = files.get(src);
      if (content) files.set(dest, content);
    }),
    readdirSync: mock((path: string) => {
      const entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }> = [];
      const prefix = path.endsWith('/') ? path : `${path}/`;

      // Collect direct children from files and dirs
      const seen = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split('/')[0]!;
          if (name && !seen.has(name)) {
            seen.add(name);
            const childPath = `${prefix}${name}`;
            const childIsDir = isDir(childPath);
            entries.push({
              name,
              isFile: () => !childIsDir,
              isDirectory: () => childIsDir,
            });
          }
        }
      }
      return entries;
    }),
    statSync: mock((path: string) => ({
      isDirectory: () => isDir(path),
    })),
  };
}

/** In-memory filesystem mock for SkillManager */
function createMockManagerFs(): SkillManagerFileOps & { files: Map<string, string> } {
  const files = new Map<string, string>();

  const isDir = (path: string) => [...files.keys()].some((k) => k.startsWith(`${path}/`));

  return {
    files,
    existsSync: mock((path: string) => files.has(path) || isDir(path)),
    mkdirSync: mock(() => {}),
    writeFileSync: mock((path: string, content: string) => {
      files.set(path, content);
    }),
    unlinkSync: mock((path: string) => {
      files.delete(path);
    }),
    rmSync: mock((path: string) => {
      for (const key of [...files.keys()]) {
        if (key.startsWith(path)) files.delete(key);
      }
    }),
    readFileSync: mock((path: string) => files.get(path) ?? ''),
    readdirSync: mock((path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const seen = new Set<string>();
      const entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }> = [];

      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split('/')[0]!;
          if (name && !seen.has(name)) {
            seen.add(name);
            const childIsDir = rest.includes('/');
            entries.push({ name, isFile: () => !childIsDir, isDirectory: () => childIsDir });
          }
        }
      }
      return entries;
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('Skills 执行管道集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── Frontmatter 解析 → Readiness 检查 ─────────────────

  describe('Frontmatter 解析 → Readiness 检查', () => {
    test('应解析 frontmatter 并检测缺失的环境变量', () => {
      const { frontmatter } = parseFrontmatter(SKILL_MD_DEPLOY);

      expect(frontmatter).not.toBeNull();
      expect(frontmatter!.name).toBe('deploy-staging');
      expect(frontmatter!.description).toBe('部署到 staging 环境');
      expect(frontmatter!.platforms).toEqual(['feishu', 'web']);

      // 未设置 DEPLOY_TOKEN → readiness 应失败
      const result = checkReadiness(frontmatter!.readiness);
      expect(result.ready).toBe(false);
      expect(result.missing).toContain('env:DEPLOY_TOKEN');
    });

    test('无依赖的 skill 应始终就绪', () => {
      const { frontmatter } = parseFrontmatter(SKILL_MD_NO_DEPS);

      expect(frontmatter).not.toBeNull();
      expect(frontmatter!.name).toBe('hello-world');

      const result = checkReadiness(frontmatter!.readiness);
      expect(result.ready).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    test('环境变量已设置时 readiness 应通过', () => {
      const { frontmatter } = parseFrontmatter(SKILL_MD_RSS);
      expect(frontmatter).not.toBeNull();

      // 临时设置环境变量
      const originalValue = process.env.RSS_API_KEY;
      process.env.RSS_API_KEY = 'test-key';
      try {
        const result = checkReadiness(frontmatter!.readiness);
        expect(result.ready).toBe(true);
        expect(result.missing).toHaveLength(0);
      } finally {
        if (originalValue === undefined) {
          delete process.env.RSS_API_KEY;
        } else {
          process.env.RSS_API_KEY = originalValue;
        }
      }
    });
  });

  // ── SkillIndexBuilder 索引生成 ─────────────────────────

  describe('SkillIndexBuilder 索引生成', () => {
    test('应生成包含所有 skill 及其就绪状态的索引', () => {
      const builder = new SkillIndexBuilder();
      const fileContents: Record<string, string> = {
        '/skills/deploy-staging/SKILL.md': SKILL_MD_DEPLOY,
        '/skills/hello-world/SKILL.md': SKILL_MD_NO_DEPS,
      };

      const skills: SkillEntry[] = [
        { name: 'deploy-staging', description: '部署到 staging', dir: '/skills/deploy-staging' },
        { name: 'hello-world', description: '简单问候', dir: '/skills/hello-world' },
      ];

      const index = builder.build({
        skills,
        loadFile: (path: string) => fileContents[path] ?? null,
      });

      expect(index).toContain('可用 Skills');
      expect(index).toContain('deploy-staging');
      expect(index).toContain('hello-world');
      // hello-world 无依赖 → ✅
      expect(index).toContain('✅');
    });

    test('应按 channel 过滤不支持的平台', () => {
      const builder = new SkillIndexBuilder();
      const fileContents: Record<string, string> = {
        '/skills/deploy-staging/SKILL.md': SKILL_MD_DEPLOY,
        '/skills/hello-world/SKILL.md': SKILL_MD_NO_DEPS,
      };

      const skills: SkillEntry[] = [
        { name: 'deploy-staging', description: '部署到 staging', dir: '/skills/deploy-staging' },
        { name: 'hello-world', description: '简单问候', dir: '/skills/hello-world' },
      ];

      // deploy-staging 只支持 feishu/web, 用 telegram 通道过滤
      const index = builder.build({
        skills,
        channel: 'telegram',
        loadFile: (path: string) => fileContents[path] ?? null,
      });

      expect(index).not.toContain('deploy-staging');
      // hello-world 没有 platforms 限制，应保留
      expect(index).toContain('hello-world');
    });

    test('超长索引应被截断到 token 预算内', () => {
      const builder = new SkillIndexBuilder();
      const skills: SkillEntry[] = [];
      const fileContents: Record<string, string> = {};

      // 生成大量 skills 使索引超过预算
      for (let i = 0; i < 500; i++) {
        const name = `skill-${i}-with-a-very-long-name-for-testing`;
        skills.push({ name, description: `这是第 ${i} 个技能的详细描述`, dir: `/skills/${name}` });
      }

      const index = builder.build({
        skills,
        contextWindowSize: 1000, // 很小的 context window → 预算仅 10 tokens
        loadFile: (path: string) => fileContents[path] ?? null,
      });

      // 应被截断
      expect(index).toContain('可用 Skills');
      expect(index.length).toBeLessThan(500 * 60); // 远小于全量
    });
  });

  // ── SkillDeployer 部署流程 ──────────────────────────────

  describe('SkillDeployer 部署流程', () => {
    test('应从 builtin 目录部署技能到 workspace', () => {
      const fs = createMockDeployerFs();

      // 模拟 builtin 目录有一个 skill
      fs.files.set('/builtin/deploy-staging/SKILL.md', SKILL_MD_DEPLOY);

      const deployer = new SkillDeployer(
        { builtinSkillsDir: '/builtin', marketplaceSkillsDir: '/marketplace' },
        fs,
      );

      const result = deployer.deploy('/workspace', { userId: 'user1' });

      expect(result.deployed).toContain('deploy-staging');
      expect(result.errors).toHaveLength(0);
    });

    test('marketplace skill 不存在时应跳过', () => {
      const fs = createMockDeployerFs();

      const deployer = new SkillDeployer(
        { builtinSkillsDir: '/builtin', marketplaceSkillsDir: '/marketplace' },
        fs,
      );

      const result = deployer.deploy('/workspace', {
        userId: 'user1',
        tenantConfig: { enabledSkills: ['nonexistent-skill'] },
      });

      expect(result.skipped).toContain('nonexistent-skill');
      expect(result.deployed).toHaveLength(0);
    });
  });

  // ── SkillManager CRUD → Index 串联 ────────────────────

  describe('SkillManager CRUD → SkillIndexBuilder 串联', () => {
    test('添加技能后应能在索引中列出', () => {
      const fs = createMockManagerFs();
      const manager = new SkillManager(fs);

      // 添加技能
      const addResult = manager.addSkill('/workspace', 'deploy-staging', {
        content: SKILL_MD_DEPLOY,
      });
      expect(addResult.command).toBe('/deploy-staging');

      // 手动标记目录存在（模拟 readdirSync 需要）
      fs.files.set('/workspace/.claude/skills/deploy-staging/SKILL.md', SKILL_MD_DEPLOY);

      // 列出技能
      const skills = manager.listSkills('/workspace');
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe('deploy-staging');
      expect(skills[0]!.command).toBe('/deploy-staging');

      // 用 SkillIndexBuilder 生成索引
      const indexBuilder = new SkillIndexBuilder();
      const entries: SkillEntry[] = skills.map((s) => ({
        name: s.name,
        description: '部署到 staging',
        dir: `/workspace/.claude/skills/${s.name}`,
      }));

      const index = indexBuilder.build({
        skills: entries,
        loadFile: (path: string) => fs.files.get(path) ?? null,
      });

      expect(index).toContain('deploy-staging');
      expect(index).toContain('可用 Skills');
    });

    test('删除技能后索引应为空', () => {
      const fs = createMockManagerFs();
      const manager = new SkillManager(fs);

      // 添加后删除
      manager.addSkill('/workspace', 'hello-world', { content: SKILL_MD_NO_DEPS });
      fs.files.set('/workspace/.claude/skills/hello-world/SKILL.md', SKILL_MD_NO_DEPS);

      manager.removeSkill('/workspace', 'hello-world');

      const skills = manager.listSkills('/workspace');
      expect(skills).toHaveLength(0);
    });
  });
});
