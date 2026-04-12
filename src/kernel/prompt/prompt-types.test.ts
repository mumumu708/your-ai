import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_CAPABILITIES,
  MEMORY_CONTEXT_BUDGET,
  SKILL_INDEX_BUDGET_PERCENT,
  SYSTEM_PROMPT_BUDGET,
  estimateTokens,
} from './prompt-types';

describe('prompt-types', () => {
  describe('estimateTokens', () => {
    test('空字符串返回 0', () => {
      expect(estimateTokens('')).toBe(0);
    });

    test('短文本按 ceil(len/4) 计算', () => {
      expect(estimateTokens('hello')).toBe(2); // ceil(5/4) = 2
      expect(estimateTokens('abcd')).toBe(1); // ceil(4/4) = 1
      expect(estimateTokens('a')).toBe(1); // ceil(1/4) = 1
    });

    test('中文文本也按字符长度计算', () => {
      const text = '你好世界'; // 4 chars
      expect(estimateTokens(text)).toBe(1);
    });

    test('长文本估算合理', () => {
      const text = 'a'.repeat(400);
      expect(estimateTokens(text)).toBe(100);
    });
  });

  describe('常量值', () => {
    test('SYSTEM_PROMPT_BUDGET = 3000', () => {
      expect(SYSTEM_PROMPT_BUDGET).toBe(3000);
    });

    test('MEMORY_CONTEXT_BUDGET = 2000', () => {
      expect(MEMORY_CONTEXT_BUDGET).toBe(2000);
    });

    test('SKILL_INDEX_BUDGET_PERCENT = 0.01', () => {
      expect(SKILL_INDEX_BUDGET_PERCENT).toBe(0.01);
    });
  });

  describe('CHANNEL_CAPABILITIES', () => {
    test('feishu 有流式卡片能力', () => {
      expect(CHANNEL_CAPABILITIES.feishu).toContain('流式卡片更新');
    });

    test('telegram 有消息编辑能力', () => {
      expect(CHANNEL_CAPABILITIES.telegram).toContain('消息编辑(2s限流)');
    });

    test('web 有 WebSocket 能力', () => {
      expect(CHANNEL_CAPABILITIES.web).toContain('WebSocket实时推送');
    });

    test('未知通道返回 undefined', () => {
      // biome-ignore lint/complexity/useLiteralKeys: testing dynamic access
      expect(CHANNEL_CAPABILITIES['unknown']).toBeUndefined();
    });
  });
});
