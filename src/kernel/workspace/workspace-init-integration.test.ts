/**
 * Integration test: simulate a new user's first conversation.
 * Validates workspace initialization including CLAUDE.md, skills deployment,
 * MCP config, and directory structure — the full context Claude Code needs.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from './workspace-manager';

const TEST_BASE_DIR = join(import.meta.dir, '__test_init_integration__');
const TEST_USER_ID = 'new_user_001';

describe('Workspace Init Integration — New User First Conversation', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let paths: ReturnType<WorkspaceManager['getWorkspacePath']>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true });
    }

    const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
    paths = manager.initializeWithMcp({
      userId: TEST_USER_ID,
      tenantId: 'tenant_001',
      workspaceDir: '', // will be filled by initializeWithMcp
      userPermissions: ['read', 'write'],
      tenantConfig: {
        thirdPartyServers: [],
        customServers: [],
        deniedTools: [],
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true });
    }
  });

  // ────────────── 1. Directory Structure ──────────────

  test('应创建完整的目录结构', () => {
    expect(existsSync(paths.absolutePath)).toBe(true);
    expect(existsSync(paths.claudeDir)).toBe(true);
    expect(existsSync(paths.skillsDir)).toBe(true);
    expect(existsSync(paths.memoryDir)).toBe(true);
    expect(existsSync(join(paths.absolutePath, 'wikis'))).toBe(true);
    expect(existsSync(join(paths.absolutePath, 'workspace', 'uploads', 'images'))).toBe(true);
    expect(existsSync(join(paths.absolutePath, 'workspace', 'uploads', 'documents'))).toBe(true);
    expect(existsSync(join(paths.absolutePath, 'workspace', 'outputs', 'generated'))).toBe(true);
    expect(existsSync(join(paths.absolutePath, 'workspace', 'projects'))).toBe(true);
  });

  // ────────────── 2. CLAUDE.md ──────────────

  test('CLAUDE.md 应存在且包含关键上下文指令', () => {
    const claudeMdPath = join(paths.absolutePath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const content = readFileSync(claudeMdPath, 'utf-8');
    // Should reference SOUL.md and USER.md for context loading
    expect(content).toContain('@memory/SOUL.md');
    expect(content).toContain('@memory/USER.md');
    // Should describe folder structure
    expect(content).toContain('.claude/');
    expect(content).toContain('skills/');
    expect(content).toContain('memory/');
    // Should reference find-skills and skill-creator
    expect(content).toContain('find-skills');
    expect(content).toContain('skill-creator');
    // Should have session end protocol
    expect(content).toContain('Session End Protocol');
  });

  // ────────────── 3. All 7 Builtin Skills Deployed ──────────────

  const EXPECTED_SKILLS = [
    'commit',
    'review-pr',
    'summarize',
    'skill-creator',
    'github-deep-research',
    'deep-research',
    'find-skills',
  ];

  test('所有 7 个 builtin skills 目录都应存在', () => {
    for (const skill of EXPECTED_SKILLS) {
      const skillDir = join(paths.skillsDir, skill);
      expect(existsSync(skillDir)).toBe(true);
    }
  });

  test('每个 skill 都应有 SKILL.md 入口文件', () => {
    for (const skill of EXPECTED_SKILLS) {
      const skillMdPath = join(paths.skillsDir, skill, 'SKILL.md');
      expect(existsSync(skillMdPath)).toBe(true);

      const content = readFileSync(skillMdPath, 'utf-8');
      // Must have frontmatter with name
      expect(content).toMatch(/^---\n/);
      expect(content).toContain(`name: ${skill}`);
      // Must have description in frontmatter
      expect(content).toMatch(/description: .+/);
      // Must have $ARGUMENTS placeholder
      expect(content).toContain('$ARGUMENTS');
    }
  });

  // ────────────── 4. Skill Content Integrity ──────────────

  test('commit skill 应包含 Conventional Commits 指导', () => {
    const content = readFileSync(join(paths.skillsDir, 'commit', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Conventional Commits');
    expect(content).toContain('git diff --cached');
    expect(content).toContain('git commit -m');
    expect(content).toContain('disable-model-invocation: true');
  });

  test('review-pr skill 应包含完整审查步骤', () => {
    const content = readFileSync(join(paths.skillsDir, 'review-pr', 'SKILL.md'), 'utf-8');
    expect(content).toContain('git diff main..HEAD');
    expect(content).toContain('安全审查');
    expect(content).toContain('disable-model-invocation: true');
  });

  test('summarize skill 应包含摘要格式', () => {
    const content = readFileSync(join(paths.skillsDir, 'summarize', 'SKILL.md'), 'utf-8');
    expect(content).toContain('一句话摘要');
    expect(content).toContain('关键要点');
  });

  test('skill-creator 应包含 SKILL.md 编写规范', () => {
    const content = readFileSync(join(paths.skillsDir, 'skill-creator', 'SKILL.md'), 'utf-8');
    expect(content).toContain('SKILL.md');
    expect(content).toContain('.claude/skills/');
  });

  test('deep-research 应包含多轮搜索指令', () => {
    const content = readFileSync(join(paths.skillsDir, 'deep-research', 'SKILL.md'), 'utf-8');
    expect(content).toContain('WebSearch');
    expect(content).toContain('WebFetch');
    expect(content).toContain('Research Report');
  });

  test('find-skills 应包含技能发现逻辑', () => {
    const content = readFileSync(join(paths.skillsDir, 'find-skills', 'SKILL.md'), 'utf-8');
    expect(content).toContain('.claude/skills/');
    expect(content).toContain('skill-creator');
  });

  // ────────────── 5. github-deep-research 附带资源 ──────────────

  test('github-deep-research 应部署 scripts/ 和 assets/', () => {
    const skillDir = join(paths.skillsDir, 'github-deep-research');

    // scripts/github_api.py
    const scriptPath = join(skillDir, 'scripts', 'github_api.py');
    expect(existsSync(scriptPath)).toBe(true);
    const scriptContent = readFileSync(scriptPath, 'utf-8');
    expect(scriptContent).toContain('api.github.com');
    expect(scriptContent).toContain('GITHUB_TOKEN');

    // assets/report_template.md
    const templatePath = join(skillDir, 'assets', 'report_template.md');
    expect(existsSync(templatePath)).toBe(true);
    const templateContent = readFileSync(templatePath, 'utf-8');
    expect(templateContent).toContain('Key Metrics');
    expect(templateContent).toContain('Recommendations');
  });

  test('github-deep-research SKILL.md 应引用相对路径的 scripts 和 assets', () => {
    const content = readFileSync(
      join(paths.skillsDir, 'github-deep-research', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('scripts/github_api.py');
    expect(content).toContain('assets/report_template.md');
  });

  // ────────────── 6. MCP 配置 ──────────────

  test('.mcp.json 应存在且包含 builtin servers', () => {
    expect(existsSync(paths.mcpJsonPath)).toBe(true);

    const mcpConfig = JSON.parse(readFileSync(paths.mcpJsonPath, 'utf-8'));
    expect(mcpConfig.mcpServers).toBeDefined();
    expect(mcpConfig.mcpServers['feishu-server']).toBeDefined();
    expect(mcpConfig.mcpServers['memory-server']).toBeDefined();
    expect(mcpConfig.mcpServers['scheduler-server']).toBeDefined();
  });

  test('.claude/settings.json 应存在且包含 permissions', () => {
    expect(existsSync(paths.settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(paths.settingsPath, 'utf-8'));
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.allow).toBeArray();
  });

  // ────────────── 7. 部署的 skill 数量正确 ──────────────

  test('skills 目录下应恰好有 7 个 skill 子目录', () => {
    const entries = readdirSync(paths.skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    expect(skillDirs.length).toBe(7);
    const names = skillDirs.map((e) => e.name).sort();
    expect(names).toEqual(EXPECTED_SKILLS.sort());
  });

  // ────────────── 8. 幂等性：重复初始化不报错 ──────────────

  test('重复调用 initializeWithMcp 不应报错', () => {
    const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
    expect(() =>
      manager.initializeWithMcp({
        userId: TEST_USER_ID,
        tenantId: 'tenant_001',
        workspaceDir: '',
        userPermissions: [],
        tenantConfig: {
          thirdPartyServers: [],
          customServers: [],
          deniedTools: [],
        },
      }),
    ).not.toThrow();
  });
});
