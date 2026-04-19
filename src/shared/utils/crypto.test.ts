import { describe, expect, test } from 'bun:test';
import { generateId, generateSessionId, generateTaskId, generateTraceId } from './crypto';

describe('generateId', () => {
  test('应该生成 prefix_timestamp_random 格式的 ID', () => {
    const id = generateId('test');
    const parts = id.split('_');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('test');
    expect(parts[1]?.length).toBeGreaterThan(0);
    expect(parts[2]?.length).toBeGreaterThan(0);
    expect(parts[2]?.length).toBeLessThanOrEqual(6);
  });

  test('应该在连续调用时生成唯一的 ID', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId('uniq'));
    }
    expect(ids.size).toBe(100);
  });

  test('空前缀也应返回非空字符串', () => {
    const id = generateId('');
    expect(id.length).toBeGreaterThan(0);
    expect(id).toContain('_');
  });
});

describe('generateTraceId', () => {
  test('应该生成带有 trace 前缀的 ID', () => {
    const id = generateTraceId();
    expect(id.startsWith('trace_')).toBe(true);
    expect(id.split('_')[0]).toBe('trace');
  });
});

describe('generateTaskId', () => {
  test('应该生成带有 task 前缀的 ID', () => {
    const id = generateTaskId();
    expect(id.startsWith('task_')).toBe(true);
    expect(id.split('_')[0]).toBe('task');
  });
});

describe('generateSessionId', () => {
  test('应该生成带有 sess 前缀的 ID', () => {
    const id = generateSessionId();
    expect(id.startsWith('sess_')).toBe(true);
    expect(id.split('_')[0]).toBe('sess');
  });
});
