import { describe, expect, test } from 'bun:test';
import type { ErrorSignal } from './error-detector';
import { extractLesson } from './lesson-extractor';

function signal(overrides: Partial<ErrorSignal> = {}): ErrorSignal {
  return {
    type: 'correction',
    text: '用英文回复',
    confidence: 0.8,
    category: 'instruction',
    ...overrides,
  };
}

describe('extractLesson', () => {
  // ─── LLM path ──────────────────────────────────────────
  test('uses LLM when llmCall is provided', async () => {
    const llmCall = async () =>
      JSON.stringify({
        action: 'reply in English',
        category: 'preference',
        lesson: 'User prefers English',
      });

    const result = await extractLesson(signal(), llmCall);
    expect(result.action).toBe('reply in English');
    expect(result.category).toBe('preference');
    expect(result.lesson).toBe('User prefers English');
  });

  test('falls back to rule-based when LLM returns invalid JSON', async () => {
    const llmCall = async () => 'not valid json';

    const result = await extractLesson(signal(), llmCall);
    expect(result.lesson).toContain('用户纠正');
  });

  test('falls back when LLM returns JSON without required fields', async () => {
    const llmCall = async () => JSON.stringify({ foo: 'bar' });

    const result = await extractLesson(signal(), llmCall);
    expect(result.lesson).toContain('用户纠正');
  });

  test('falls back when LLM throws', async () => {
    const llmCall = async () => {
      throw new Error('LLM unavailable');
    };

    const result = await extractLesson(signal(), llmCall);
    expect(result.lesson).toContain('用户纠正');
  });

  test('uses signal.category as default when LLM omits category', async () => {
    const llmCall = async () => JSON.stringify({ action: 'do X', lesson: 'lesson Y' });

    const result = await extractLesson(signal({ category: 'fact' }), llmCall);
    expect(result.category).toBe('fact');
  });

  // ─── Rule-based fallback ───────────────────────────────
  test('rule-based for null llmCall', async () => {
    const result = await extractLesson(signal(), null);
    expect(result.action).toBe('用英文回复');
    expect(result.category).toBe('instruction');
    expect(result.lesson).toBe('用户纠正：用英文回复');
  });

  test('rule-based for undefined llmCall', async () => {
    const result = await extractLesson(signal());
    expect(result.lesson).toBe('用户纠正：用英文回复');
  });

  test('rule-based for repetition signal', async () => {
    const result = await extractLesson(signal({ type: 'repetition' }));
    expect(result.lesson).toBe('用户多次请求未得到满意回应，需改进处理方式');
  });

  test('rule-based for frustration signal', async () => {
    const result = await extractLesson(signal({ type: 'frustration' }));
    expect(result.lesson).toBe('用户表达不满，需改进交互体验');
  });

  test('truncates action to 60 chars', async () => {
    const longText = 'a'.repeat(100);
    const result = await extractLesson(signal({ text: longText }));
    expect(result.action).toHaveLength(60);
  });
});
