import { describe, expect, test } from 'bun:test';
import { buildPrependContext } from './prepend-context-builder';

describe('buildPrependContext', () => {
  test('输出包含 system-reminder 标签', () => {
    const result = buildPrependContext({
      agentsConfig: '# Agents',
      userConfig: '# User Profile',
    });

    expect(result).toStartWith('<system-reminder>');
    expect(result).toEndWith('</system-reminder>');
  });

  test('输出包含 OVERRIDE 语义声明', () => {
    const result = buildPrependContext({
      agentsConfig: '',
      userConfig: '',
    });

    expect(result).toContain('OVERRIDE');
    expect(result).toContain('IMPORTANT');
  });

  test('输出包含 agentsConfig 内容', () => {
    const result = buildPrependContext({
      agentsConfig: '## Memory 交互协议\n- 检索记忆',
      userConfig: '',
    });

    expect(result).toContain('# claudeMd');
    expect(result).toContain('Memory 交互协议');
    expect(result).toContain('检索记忆');
  });

  test('输出包含 userConfig 内容', () => {
    const result = buildPrependContext({
      agentsConfig: '',
      userConfig: '喜欢简洁回复\n使用 TypeScript',
    });

    expect(result).toContain('# userProfile');
    expect(result).toContain('喜欢简洁回复');
    expect(result).toContain('使用 TypeScript');
  });

  test('输出包含当前日期', () => {
    const result = buildPrependContext({
      agentsConfig: '',
      userConfig: '',
    });

    expect(result).toContain('# currentDate');
    const datePattern = /Today's date is \d{4}-\d{2}-\d{2}\./;
    expect(result).toMatch(datePattern);
  });

  test('sections 按正确顺序排列: claudeMd → userProfile → currentDate', () => {
    const result = buildPrependContext({
      agentsConfig: 'AGENTS_CONTENT',
      userConfig: 'USER_CONTENT',
    });

    const idxClaudeMd = result.indexOf('# claudeMd');
    const idxUserProfile = result.indexOf('# userProfile');
    const idxCurrentDate = result.indexOf('# currentDate');

    expect(idxClaudeMd).toBeLessThan(idxUserProfile);
    expect(idxUserProfile).toBeLessThan(idxCurrentDate);
  });

  test('空配置时结构仍然完整', () => {
    const result = buildPrependContext({
      agentsConfig: '',
      userConfig: '',
    });

    expect(result).toContain('# claudeMd');
    expect(result).toContain('# userProfile');
    expect(result).toContain('# currentDate');
    expect(result).toContain('<system-reminder>');
    expect(result).toContain('</system-reminder>');
  });
});
