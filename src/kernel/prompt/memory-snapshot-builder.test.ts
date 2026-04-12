import { describe, expect, test } from 'bun:test';
import { buildMemorySnapshot } from './memory-snapshot-builder';
import { estimateTokens } from './prompt-types';

describe('buildMemorySnapshot', () => {
  test('空输入返回空字符串', () => {
    expect(buildMemorySnapshot([])).toBe('');
  });

  test('按 category 分组格式化', () => {
    const result = buildMemorySnapshot([
      { content: '偏好中文回复', category: 'preference' },
      { content: '使用 TypeScript', category: 'fact' },
      { content: '正在开发 AI 助手项目', category: 'context' },
    ]);

    expect(result).toContain('# Memory Snapshot');
    expect(result).toContain('## 用户偏好');
    expect(result).toContain('- 偏好中文回复');
    expect(result).toContain('## 关键事实');
    expect(result).toContain('- 使用 TypeScript');
    expect(result).toContain('## 项目上下文');
    expect(result).toContain('- 正在开发 AI 助手项目');
  });

  test('无 category 默认归入 fact', () => {
    const result = buildMemorySnapshot([{ content: '无分类记忆' }]);

    expect(result).toContain('## 关键事实');
    expect(result).toContain('- 无分类记忆');
    expect(result).not.toContain('## 用户偏好');
    expect(result).not.toContain('## 项目上下文');
  });

  test('每个 category 最多保留 5 条', () => {
    const memories = Array.from({ length: 8 }, (_, i) => ({
      content: `事实 ${i + 1}`,
      category: 'fact' as const,
    }));

    const result = buildMemorySnapshot(memories);
    expect(result).toContain('- 事实 5');
    expect(result).not.toContain('- 事实 6');
  });

  test('超长内容被截断到 800 token 以内', () => {
    // Each memory item is ~700 chars, 5 items per category * 3 categories = way over 800 tokens
    const longContent = '这是一段很长的记忆内容，需要被截断。'.repeat(40); // ~640 chars
    const longMemories = [
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `${longContent} pref-${i}`,
        category: 'preference' as const,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `${longContent} fact-${i}`,
        category: 'fact' as const,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `${longContent} ctx-${i}`,
        category: 'context' as const,
      })),
    ];

    const result = buildMemorySnapshot(longMemories);
    // 800 tokens * 4 chars/token = 3200 chars max
    expect(result.length).toBeLessThanOrEqual(3200);
    expect(estimateTokens(result)).toBeLessThanOrEqual(800);
  });

  test('只有偏好类记忆时只显示偏好 section', () => {
    const result = buildMemorySnapshot([{ content: '喜欢简洁回复', category: 'preference' }]);

    expect(result).toContain('## 用户偏好');
    expect(result).not.toContain('## 关键事实');
    expect(result).not.toContain('## 项目上下文');
  });

  test('多种 category 混合时按正确顺序排列', () => {
    const result = buildMemorySnapshot([
      { content: '上下文信息', category: 'context' },
      { content: '偏好信息', category: 'preference' },
      { content: '事实信息', category: 'fact' },
    ]);

    const prefIdx = result.indexOf('## 用户偏好');
    const factIdx = result.indexOf('## 关键事实');
    const ctxIdx = result.indexOf('## 项目上下文');

    expect(prefIdx).toBeLessThan(factIdx);
    expect(factIdx).toBeLessThan(ctxIdx);
  });
});
