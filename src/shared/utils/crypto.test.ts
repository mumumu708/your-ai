import { describe, expect, test } from 'bun:test';
import { generateId, generateSessionId, generateTaskId, generateTraceId } from './crypto';

describe('generateId', () => {
  test('应该生成带有正确前缀的 ID', () => {
    const id = generateId('test');
    expect(id.startsWith('test_')).toBe(true);
  });

  test('应该在连续调用时生成唯一的 ID', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId('uniq'));
    }
    expect(ids.size).toBe(100);
  });
});

describe('generateTraceId', () => {
  test('应该生成带有 trace 前缀的 ID', () => {
    const id = generateTraceId();
    expect(id.startsWith('trace_')).toBe(true);
  });
});

describe('generateTaskId', () => {
  test('应该生成带有 task 前缀的 ID', () => {
    const id = generateTaskId();
    expect(id.startsWith('task_')).toBe(true);
  });
});

describe('generateSessionId', () => {
  test('应该生成带有 sess 前缀的 ID', () => {
    const id = generateSessionId();
    expect(id.startsWith('sess_')).toBe(true);
  });
});
