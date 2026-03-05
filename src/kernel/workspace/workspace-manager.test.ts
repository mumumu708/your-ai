import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from './workspace-manager';

const TEST_BASE_DIR = join(import.meta.dir, '__test_workspace__');

describe('WorkspaceManager', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    // Clean up test directory
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    // Clean up test directory
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true });
    }
  });

  describe('getWorkspacePath', () => {
    test('应该返回正确的路径结构', () => {
      const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
      const paths = manager.getWorkspacePath('user_001');

      expect(paths.absolutePath).toEndWith('user_001');
      expect(paths.claudeDir).toContain('user_001/.claude');
      expect(paths.settingsPath).toContain('user_001/.claude/settings.json');
      expect(paths.memoryDir).toContain('user_001/memory');
      expect(paths.skillsDir).toContain('user_001/.claude/skills');
    });
  });

  describe('ensureWorkspace', () => {
    test('应该创建完整的目录结构', () => {
      const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
      const paths = manager.ensureWorkspace('user_001');

      expect(existsSync(paths.absolutePath)).toBe(true);
      expect(existsSync(paths.claudeDir)).toBe(true);
      expect(existsSync(paths.skillsDir)).toBe(true);
      expect(existsSync(paths.memoryDir)).toBe(true);
      expect(existsSync(paths.settingsPath)).toBe(true);
      // workspace subdirectories
      expect(existsSync(join(paths.absolutePath, 'workspace', 'uploads', 'images'))).toBe(true);
      expect(existsSync(join(paths.absolutePath, 'workspace', 'outputs', 'generated'))).toBe(true);
      expect(existsSync(join(paths.absolutePath, 'workspace', 'projects'))).toBe(true);
      expect(existsSync(join(paths.absolutePath, 'wikis'))).toBe(true);
      // CLAUDE.md
      expect(existsSync(join(paths.absolutePath, 'CLAUDE.md'))).toBe(true);
    });

    test('应该生成 claude settings.json', () => {
      const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
      const paths = manager.ensureWorkspace('user_001');

      const content = JSON.parse(require('node:fs').readFileSync(paths.settingsPath, 'utf-8'));
      expect(content.permissions).toBeDefined();
      expect(content.model).toBeDefined();
    });

    test('重复调用不应该报错', () => {
      const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
      manager.ensureWorkspace('user_001');
      expect(() => manager.ensureWorkspace('user_001')).not.toThrow();
    });

    test('不同用户应该有不同的工作空间', () => {
      const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
      const paths1 = manager.ensureWorkspace('user_001');
      const paths2 = manager.ensureWorkspace('user_002');

      expect(paths1.absolutePath).not.toBe(paths2.absolutePath);
      expect(existsSync(paths1.absolutePath)).toBe(true);
      expect(existsSync(paths2.absolutePath)).toBe(true);
    });
  });

  describe('generateClaudeSettings', () => {
    test('应该生成有效的 JSON 配置文件', () => {
      const manager = new WorkspaceManager({ baseDir: TEST_BASE_DIR });
      const paths = manager.ensureWorkspace('user_001');

      const content = JSON.parse(require('node:fs').readFileSync(paths.settingsPath, 'utf-8'));

      expect(content.permissions.allow).toBeArray();
      expect(content.permissions.deny).toBeArray();
      expect(content.maxTokens).toBeGreaterThan(0);
    });
  });
});
