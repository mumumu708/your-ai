import { describe, expect, test } from 'bun:test';
import {
  buildMemorySnapshot,
  computeSnapshotScore,
} from './memory-snapshot-builder';
import type { MemoryItem } from './memory-snapshot-builder';
import { estimateTokens } from './prompt-types';

describe('buildMemorySnapshot', () => {
  test('空输入返回空字符串', () => {
    expect(buildMemorySnapshot([])).toBe('');
  });

  test('按 category 分组格式化（6 个 category）', () => {
    const result = buildMemorySnapshot([
      { content: '偏好中文回复', category: 'preference' },
      { content: '使用 TypeScript', category: 'fact' },
      { content: '正在开发 AI 助手项目', category: 'context' },
      { content: '回复要简洁', category: 'instruction' },
      { content: 'Rust 所有权总结', category: 'insight' },
      { content: '完成记忆系统重构', category: 'task' },
    ]);

    expect(result).toContain('# Memory Snapshot');
    expect(result).toContain('## 用户偏好');
    expect(result).toContain('- 偏好中文回复');
    expect(result).toContain('## 关键事实');
    expect(result).toContain('- 使用 TypeScript');
    expect(result).toContain('## 项目上下文');
    expect(result).toContain('- 正在开发 AI 助手项目');
    expect(result).toContain('## 行为指令');
    expect(result).toContain('- 回复要简洁');
    expect(result).toContain('## 总结洞察');
    expect(result).toContain('- Rust 所有权总结');
    expect(result).toContain('## 活跃任务');
    expect(result).toContain('- 完成记忆系统重构');
  });

  test('无 category 默认归入 fact', () => {
    const result = buildMemorySnapshot([{ content: '无分类记忆' }]);

    expect(result).toContain('## 关键事实');
    expect(result).toContain('- 无分类记忆');
    expect(result).not.toContain('## 用户偏好');
  });

  test('每个 category 按 maxItems 截断', () => {
    const memories = Array.from({ length: 8 }, (_, i) => ({
      content: `事实 ${i + 1}`,
      category: 'fact' as const,
    }));

    const result = buildMemorySnapshot(memories);
    expect(result).toContain('- 事实 5');
    expect(result).not.toContain('- 事实 6');
  });

  test('instruction/insight/task 每类最多 3 条', () => {
    const memories = Array.from({ length: 5 }, (_, i) => ({
      content: `指令 ${i + 1}`,
      category: 'instruction' as const,
    }));

    const result = buildMemorySnapshot(memories);
    expect(result).toContain('- 指令 3');
    expect(result).not.toContain('- 指令 4');
  });

  test('超长内容被截断到 800 token 以内', () => {
    const longContent = '这是一段很长的记忆内容，需要被截断。'.repeat(40);
    const longMemories = [
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `${longContent} pref-${i}`,
        category: 'preference' as const,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `${longContent} fact-${i}`,
        category: 'fact' as const,
      })),
    ];

    const result = buildMemorySnapshot(longMemories);
    expect(estimateTokens(result)).toBeLessThanOrEqual(800);
  });

  test('高 importance + 近期的条目排在前面', () => {
    const now = Date.now();
    const memories: MemoryItem[] = [
      { content: '旧的低优先', category: 'fact', importance: 0.2, updatedAt: now - 90 * 86_400_000 },
      { content: '新的高优先', category: 'fact', importance: 0.9, updatedAt: now },
      { content: '旧的高优先', category: 'fact', importance: 0.9, updatedAt: now - 60 * 86_400_000 },
      { content: '新的低优先', category: 'fact', importance: 0.2, updatedAt: now },
    ];

    const result = buildMemorySnapshot(memories);
    const lines = result.split('\n').filter((l) => l.startsWith('- '));

    // 新的高优先应排第一
    expect(lines[0]).toContain('新的高优先');
  });

  test('section 按 category 固定顺序排列', () => {
    const result = buildMemorySnapshot([
      { content: '任务', category: 'task' },
      { content: '偏好', category: 'preference' },
      { content: '事实', category: 'fact' },
      { content: '洞察', category: 'insight' },
    ]);

    const prefIdx = result.indexOf('## 用户偏好');
    const factIdx = result.indexOf('## 关键事实');
    const insightIdx = result.indexOf('## 总结洞察');
    const taskIdx = result.indexOf('## 活跃任务');

    expect(prefIdx).toBeLessThan(factIdx);
    expect(insightIdx).toBeLessThan(taskIdx);
  });

  test('只有偏好类记忆时只显示偏好 section', () => {
    const result = buildMemorySnapshot([{ content: '喜欢简洁回复', category: 'preference' }]);

    expect(result).toContain('## 用户偏好');
    expect(result).not.toContain('## 关键事实');
  });
});

describe('computeSnapshotScore', () => {
  test('高 importance 得高分', () => {
    const high = computeSnapshotScore({ content: '', importance: 1.0 });
    const low = computeSnapshotScore({ content: '', importance: 0.1 });
    expect(high).toBeGreaterThan(low);
  });

  test('近期更新得高分', () => {
    const now = Date.now();
    const recent = computeSnapshotScore({ content: '', updatedAt: now });
    const old = computeSnapshotScore({ content: '', updatedAt: now - 90 * 86_400_000 });
    expect(recent).toBeGreaterThan(old);
  });

  test('高 accessCount 得 bonus', () => {
    const popular = computeSnapshotScore({ content: '', accessCount: 20 });
    const unused = computeSnapshotScore({ content: '', accessCount: 0 });
    expect(popular).toBeGreaterThan(unused);
  });

  test('accessBonus 上限为 0.3', () => {
    const s1 = computeSnapshotScore({ content: '', accessCount: 100 });
    const s2 = computeSnapshotScore({ content: '', accessCount: 50 });
    // Both should cap at the same accessBonus
    expect(s1).toBe(s2);
  });

  test('无 metadata 的默认分数', () => {
    const score = computeSnapshotScore({ content: '' });
    // importance=0.5*0.5 + recency=1.0*0.3 + access=0*0.2 = 0.55
    expect(score).toBeCloseTo(0.55, 1);
  });
});
