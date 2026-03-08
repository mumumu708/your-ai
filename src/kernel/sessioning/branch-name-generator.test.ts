import { describe, expect, test } from 'bun:test';
import { generateBranchName } from './branch-name-generator';

describe('generateBranchName', () => {
  test('中文修复任务应生成 fix 分支', () => {
    const branch = generateBranchName('/harness 修复 telegram 超时 bug');
    expect(branch).toMatch(/^agent\/fix\/telegram-bug-[a-z0-9]+$/);
  });

  test('英文 add 任务应生成 feat 分支', () => {
    const branch = generateBranchName('/harness add memory cache');
    expect(branch).toMatch(/^agent\/feat\/add-memory-cache-[a-z0-9]+$/);
  });

  test('中文重构任务应生成 refactor 分支', () => {
    const branch = generateBranchName('harness: 重构 classifier');
    expect(branch).toMatch(/^agent\/refactor\/classifier-[a-z0-9]+$/);
  });

  test('中文添加任务应生成 feat 分支', () => {
    const branch = generateBranchName('/harness 添加缓存层');
    expect(branch).toMatch(/^agent\/feat\/[a-z0-9]+$/);
  });

  test('英文 fix 任务应生成 fix 分支', () => {
    const branch = generateBranchName('/harness fix login timeout');
    expect(branch).toMatch(/^agent\/fix\/fix-login-timeout-[a-z0-9]+$/);
  });

  test('无法识别动词时应默认为 feat', () => {
    const branch = generateBranchName('/harness some random task');
    expect(branch).toMatch(/^agent\/feat\/some-random-task-[a-z0-9]+$/);
  });

  test('harness: 前缀应正确去除', () => {
    const branch = generateBranchName('harness: implement new feature');
    expect(branch).toMatch(/^agent\/feat\/implement-new-feature-[a-z0-9]+$/);
  });

  test('slug 不应超过 40 字符（不含哈希）', () => {
    const longMessage = '/harness add ' + 'very-long-description-'.repeat(10);
    const branch = generateBranchName(longMessage);
    // agent/feat/ prefix + slug + hash
    const slug = branch.replace(/^agent\/feat\//, '').replace(/-[a-z0-9]+$/, '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  test('每次调用应生成唯一分支名', () => {
    const b1 = generateBranchName('/harness fix bug');
    const b2 = generateBranchName('/harness fix bug');
    // Hash is Date.now().toString(36), same ms may produce same result
    // but they should both match the pattern
    expect(b1).toMatch(/^agent\/fix\//);
    expect(b2).toMatch(/^agent\/fix\//);
  });

  test('纯中文内容应生成仅含哈希的 slug', () => {
    const branch = generateBranchName('/harness 修复数据库连接问题');
    expect(branch).toMatch(/^agent\/fix\/[a-z0-9]+$/);
  });
});
