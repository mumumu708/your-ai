import { describe, expect, test } from 'bun:test';
import { TaskGuidanceBuilder } from './task-guidance-builder';

describe('TaskGuidanceBuilder', () => {
  const builder = new TaskGuidanceBuilder();

  describe('execution modes', () => {
    test('sync 模式 → 简洁直接', () => {
      const result = builder.build({
        taskType: 'chat',
        executionMode: 'sync',
      });

      expect(result).toContain('任务类型：chat（sync）');
      expect(result).toContain('简洁直接回答。');
    });

    test('async 模式 → 后台任务提示', () => {
      const result = builder.build({
        taskType: 'reflection',
        executionMode: 'async',
      });

      expect(result).toContain('任务类型：reflection（async）');
      expect(result).toContain('这是后台任务。完成后结果将推送给用户。');
    });

    test('long-horizon 模式 → 长时间任务提示', () => {
      const result = builder.build({
        taskType: 'deep-research',
        executionMode: 'long-horizon',
      });

      expect(result).toContain('任务类型：deep-research（long-horizon）');
      expect(result).toContain('这是长时间任务。定期输出进展，用户可能中途追加指令。');
      expect(result).toContain('建议：先分解步骤，逐步执行，必要时 delegate 子任务。');
    });
  });

  describe('skill 推荐', () => {
    test('有匹配 skill 时包含推荐', () => {
      const result = builder.build({
        taskType: 'chat',
        executionMode: 'sync',
        matchedSkills: ['web-search', 'code-review'],
      });

      expect(result).toContain('推荐 skill: web-search, code-review。请先 skill_view 加载。');
    });

    test('无匹配 skill 时不包含推荐', () => {
      const result = builder.build({
        taskType: 'chat',
        executionMode: 'sync',
        matchedSkills: [],
      });

      expect(result).not.toContain('推荐 skill');
    });

    test('未提供 matchedSkills 时不包含推荐', () => {
      const result = builder.build({
        taskType: 'chat',
        executionMode: 'sync',
      });

      expect(result).not.toContain('推荐 skill');
    });
  });

  describe('harness 任务', () => {
    test('harness + workspace → 包含工作目录和检查提示', () => {
      const result = builder.build({
        taskType: 'harness',
        executionMode: 'long-horizon',
        workspacePath: '/home/user/project',
      });

      expect(result).toContain('工作目录：/home/user/project');
      expect(result).toContain('完成后运行项目检查命令验证。');
    });

    test('harness 无 workspace → 不包含工作目录', () => {
      const result = builder.build({
        taskType: 'harness',
        executionMode: 'sync',
      });

      expect(result).not.toContain('工作目录');
    });

    test('非 harness 有 workspace → 不包含工作目录', () => {
      const result = builder.build({
        taskType: 'chat',
        executionMode: 'sync',
        workspacePath: '/home/user/project',
      });

      expect(result).not.toContain('工作目录');
    });
  });

  describe('组合场景', () => {
    test('完整的 harness long-horizon + skills', () => {
      const result = builder.build({
        taskType: 'harness',
        executionMode: 'long-horizon',
        workspacePath: '/workspace',
        matchedSkills: ['code-review'],
      });

      const lines = result.split('\n');
      expect(lines[0]).toBe('任务类型：harness（long-horizon）');
      expect(lines).toContain('这是长时间任务。定期输出进展，用户可能中途追加指令。');
      expect(lines).toContain('推荐 skill: code-review。请先 skill_view 加载。');
      expect(lines).toContain('工作目录：/workspace');
      expect(lines).toContain('完成后运行项目检查命令验证。');
    });
  });
});
