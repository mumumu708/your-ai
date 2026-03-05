import { describe, expect, test } from 'bun:test';
import type { KnowledgeFragment } from './evolution-types';
import { TokenBudgetAllocator } from './token-budget-allocator';

function makeFragment(
  source: KnowledgeFragment['source'],
  content: string,
  priority: number,
): KnowledgeFragment {
  const allocator = new TokenBudgetAllocator();
  return {
    source,
    content,
    priority,
    tokens: allocator.estimateTokens(content),
  };
}

describe('TokenBudgetAllocator', () => {
  const allocator = new TokenBudgetAllocator();

  describe('estimateTokens', () => {
    test('应该按 4 字符/token 估算', () => {
      expect(allocator.estimateTokens('abcdefgh')).toBe(2);
      expect(allocator.estimateTokens('abc')).toBe(1);
      expect(allocator.estimateTokens('')).toBe(0);
    });
  });

  describe('trimFragment', () => {
    test('不超预算的片段应该原样返回', () => {
      const fragment = makeFragment('identity', 'Hello world', 10);
      const result = allocator.trimFragment(fragment, 100);
      expect(result.content).toBe('Hello world');
    });

    test('超出预算的片段应该在句子边界截断', () => {
      const content = 'First sentence. Second sentence. Third sentence is very long.';
      const fragment = makeFragment('identity', content, 10);
      // Budget for ~20 chars = 5 tokens
      const result = allocator.trimFragment(fragment, 5);
      expect(result.content.length).toBeLessThanOrEqual(20 + 2);
      expect(result.tokens).toBeLessThanOrEqual(5 + 1);
    });
  });

  describe('allocate', () => {
    test('空输入应该返回空数组', () => {
      expect(allocator.allocate([], 1000)).toEqual([]);
    });

    test('所有片段在预算内应该全部返回', () => {
      const fragments = [
        makeFragment('identity', 'I am a bot', 10),
        makeFragment('memory', 'User likes coffee', 4),
        makeFragment('session', 'Discussed weather', 2),
      ];
      const result = allocator.allocate(fragments, 1000);
      expect(result.length).toBe(3);
    });

    test('应该按优先级排序后分配', () => {
      const fragments = [
        makeFragment('identity', 'Low priority identity', 5),
        makeFragment('identity', 'High priority identity', 10),
      ];
      // Very tight budget: only room for one
      const result = allocator.allocate(fragments, 8);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].priority).toBe(10);
    });

    test('未用完的桶预算应该重新分配', () => {
      const fragments = [
        makeFragment('identity', 'Short', 10), // tiny identity - leaves spare budget
        makeFragment('memory', 'A'.repeat(400), 5), // large memory fragment
        makeFragment('memory', 'B'.repeat(400), 4), // another large memory
      ];
      // Total budget: 300 tokens. identity bucket = 90 tokens but only uses ~2.
      // Memory bucket = 150, session = 60 -> unused budget should help fit more memory
      const result = allocator.allocate(fragments, 300);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test('溢出时应该截断片段', () => {
      const longContent = 'This is a long sentence. '.repeat(100);
      const fragments = [makeFragment('identity', longContent, 10)];
      const result = allocator.allocate(fragments, 50);
      expect(result.length).toBeGreaterThanOrEqual(1);
      // Total tokens should not exceed budget significantly
      const totalTokens = result.reduce((sum, f) => sum + f.tokens, 0);
      expect(totalTokens).toBeLessThanOrEqual(60);
    });
  });
});
