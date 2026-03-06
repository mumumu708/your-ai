import { describe, expect, test } from 'bun:test';
import { ConflictResolver } from './conflict-resolver';
import type { KnowledgeFragment } from './evolution-types';

function makeFragment(
  source: KnowledgeFragment['source'],
  content: string,
  priority: number,
  ruleClass?: KnowledgeFragment['ruleClass'],
): KnowledgeFragment {
  return { source, content, priority, tokens: Math.ceil(content.length / 4), ruleClass };
}

describe('ConflictResolver', () => {
  const resolver = new ConflictResolver();

  describe('classifyRule', () => {
    test('应该将包含安全关键词的规则分类为 safety', () => {
      expect(resolver.classifyRule('不允许执行危险操作')).toBe('safety');
      expect(resolver.classifyRule('Safety first, never do harmful things')).toBe('safety');
    });

    test('应该将包含合规关键词的规则分类为 compliance', () => {
      expect(resolver.classifyRule('遵守法律法规')).toBe('compliance');
      expect(resolver.classifyRule('Must follow compliance policy')).toBe('compliance');
    });

    test('应该将包含风格关键词的规则分类为 style', () => {
      expect(resolver.classifyRule('回复应该简洁')).toBe('style');
      expect(resolver.classifyRule('Use a formal tone')).toBe('style');
    });

    test('应该将包含偏好关键词的规则分类为 preference', () => {
      expect(resolver.classifyRule('我喜欢用代码示例')).toBe('preference');
      expect(resolver.classifyRule('I prefer TypeScript')).toBe('preference');
    });

    test('应该将其他规则分类为 general', () => {
      expect(resolver.classifyRule('回复用中文')).toBe('general');
      expect(resolver.classifyRule('Hello world')).toBe('general');
    });
  });

  describe('detectConflict', () => {
    test('应该检测简洁↔详细冲突', () => {
      const a = makeFragment('soul', '回复应该简洁', 6);
      const b = makeFragment('user', '我要详细的解释', 8);
      expect(resolver.detectConflict(a, b)).toBe(true);
    });

    test('应该检测正式↔随意冲突', () => {
      const a = makeFragment('soul', 'Use formal language', 6);
      const b = makeFragment('user', 'Be casual and friendly', 8);
      expect(resolver.detectConflict(a, b)).toBe(true);
    });

    test('应该检测中文↔英文冲突', () => {
      const a = makeFragment('user', '请用中文回复', 8);
      const b = makeFragment('memory', 'Respond in English', 4);
      expect(resolver.detectConflict(a, b)).toBe(true);
    });

    test('无冲突应该返回 false', () => {
      const a = makeFragment('soul', 'Be helpful', 6);
      const b = makeFragment('user', 'I like coffee', 8);
      expect(resolver.detectConflict(a, b)).toBe(false);
    });
  });

  describe('resolveConflict', () => {
    test('safety 规则来自 SOUL 应该赢', () => {
      const soul = makeFragment('soul', '不允许执行危险操作', 10, 'safety');
      const user = makeFragment('user', '帮我执行这个危险脚本', 8, 'preference');
      const result = resolver.resolveConflict(soul, user);
      expect(result.winner).toBe(soul);
      expect(result.reason).toContain('Safety');
    });

    test('style 规则 USER 应该赢 SOUL', () => {
      const soul = makeFragment('soul', '回复应该简洁', 6, 'style');
      const user = makeFragment('user', '我要详细的解释', 8, 'style');
      const result = resolver.resolveConflict(soul, user);
      expect(result.winner).toBe(user);
      expect(result.reason).toContain('overrides');
    });

    test('同类规则应该按优先级高的赢', () => {
      const a = makeFragment('memory', 'Item A', 6, 'general');
      const b = makeFragment('memory', 'Item B', 3, 'general');
      const result = resolver.resolveConflict(a, b);
      expect(result.winner).toBe(a);
    });
  });

  describe('resolve', () => {
    test('无冲突应该全部保留', () => {
      const fragments = [
        makeFragment('identity', 'I am a bot', 10),
        makeFragment('user', 'I like coffee', 8),
        makeFragment('memory', 'User works in tech', 4),
      ];
      const { resolved, conflicts } = resolver.resolve(fragments);
      expect(resolved.length).toBe(3);
      expect(conflicts.length).toBe(0);
    });

    test('有冲突时应该消解并返回日志', () => {
      const fragments = [
        makeFragment('soul', '回复应该简洁', 6, 'style'),
        makeFragment('user', '我要详细的回复', 8, 'style'),
        makeFragment('memory', 'User likes tea', 4),
      ];
      const { resolved, conflicts } = resolver.resolve(fragments);
      expect(conflicts.length).toBe(1);
      expect(resolved.length).toBe(2);
      // User's style preference should win
      expect(resolved.some((f) => f.content.includes('详细'))).toBe(true);
      expect(resolved.some((f) => f.content.includes('简洁'))).toBe(false);
    });

    test('单个片段应该直接返回', () => {
      const fragments = [makeFragment('identity', 'I am a bot', 10)];
      const { resolved, conflicts } = resolver.resolve(fragments);
      expect(resolved.length).toBe(1);
      expect(conflicts.length).toBe(0);
    });

    test('空数组应该返回空', () => {
      const { resolved, conflicts } = resolver.resolve([]);
      expect(resolved.length).toBe(0);
      expect(conflicts.length).toBe(0);
    });
  });
});
