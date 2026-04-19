import { describe, expect, test } from 'bun:test';
import type { ConversationMessage } from '../shared/agents/agent-instance.types';
import { detectErrorSignal } from './error-detector';

function msg(content: string): ConversationMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

describe('detectErrorSignal', () => {
  // ─── False positives ───────────────────────────────────
  test('returns null for false positive phrases', () => {
    expect(detectErrorSignal('no problem', [])).toBeNull();
    expect(detectErrorSignal('no worries', [])).toBeNull();
    expect(detectErrorSignal('No thanks', [])).toBeNull();
    expect(detectErrorSignal('no way', [])).toBeNull();
    expect(detectErrorSignal('no idea', [])).toBeNull();
    expect(detectErrorSignal('no doubt', [])).toBeNull();
  });

  // ─── Correction patterns ──────────────────────────────
  test('detects Chinese correction "我说的是"', () => {
    const result = detectErrorSignal('我说的是 用英文回复我的问题就好', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
    expect(result?.category).toBe('instruction');
    expect(result?.confidence).toBe(0.8);
  });

  test('detects Chinese correction "我的意思是"', () => {
    const result = detectErrorSignal('我的意思是 不要用markdown格式', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects Chinese correction "不是"', () => {
    const result = detectErrorSignal('不是，我想要的是另一个结果', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects Chinese correction "不对"', () => {
    const result = detectErrorSignal('不对，应该用另外的方式', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects Chinese correction "错了"', () => {
    const result = detectErrorSignal('错了，这不是我要的东西啊', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects Chinese correction "纠正"', () => {
    const result = detectErrorSignal('纠正一下 正确答案应该是ABC', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects English correction "no,"', () => {
    const result = detectErrorSignal('no, I want it in English please', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
    expect(result?.category).toBe('instruction');
  });

  test('detects English correction "wrong"', () => {
    const result = detectErrorSignal('wrong, the answer should be 42', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects English correction "actually"', () => {
    const result = detectErrorSignal('actually, I meant the other file', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects English correction "I said"', () => {
    const result = detectErrorSignal('I said use TypeScript not JavaScript', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects English correction "I meant"', () => {
    const result = detectErrorSignal('I meant the production database here', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects English correction "I wanted"', () => {
    const result = detectErrorSignal('I wanted a different approach please', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('correction');
  });

  test('detects Chinese preference "不要"', () => {
    const result = detectErrorSignal('不要使用markdown格式来回复', []);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('preference');
  });

  test('detects Chinese preference "别"', () => {
    const result = detectErrorSignal('别再给我推荐那种东西了', []);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('preference');
  });

  test('detects Chinese preference "以后"', () => {
    const result = detectErrorSignal('以后用简短的方式回复就好', []);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('preference');
  });

  test('detects Chinese preference "下次"', () => {
    const result = detectErrorSignal('下次直接给我代码就好不要解释', []);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('preference');
  });

  test('detects Chinese preference "记住"', () => {
    const result = detectErrorSignal('记住我喜欢用中文交流不要英文', []);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('preference');
  });

  // ─── Frustration ──────────────────────────────────────
  test('detects frustration "又错了"', () => {
    const result = detectErrorSignal('又错了', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('frustration');
    expect(result?.confidence).toBe(0.7);
    expect(result?.category).toBe('instruction');
  });

  test('detects frustration "还是不对"', () => {
    const result = detectErrorSignal('还是不对', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('frustration');
  });

  test('detects frustration "already told you"', () => {
    const result = detectErrorSignal('I already told you that', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('frustration');
  });

  test('detects frustration "stop doing"', () => {
    const result = detectErrorSignal('please stop doing that', []);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('frustration');
  });

  // ─── Repetition ───────────────────────────────────────
  test('detects repetition when user sends nearly identical message', () => {
    const history = [
      msg('please translate this code to python language now'),
      { role: 'assistant' as const, content: 'OK', timestamp: Date.now() },
    ];
    // Identical tokens with slight variation — Jaccard > 0.8
    detectErrorSignal('please translate this code to python language now', history);
    // The identical message is filtered out from comparison, so try a very similar one
    const result2 = detectErrorSignal('please translate this code to python language', history);
    expect(result2).not.toBeNull();
    expect(result2?.type).toBe('repetition');
    expect(result2?.confidence).toBe(0.6);
  });

  test('ignores short messages for repetition check', () => {
    const history = [msg('hi')];
    const result = detectErrorSignal('hi', history);
    expect(result).toBeNull();
  });

  test('does not flag non-similar messages as repetition', () => {
    const history = [msg('what is the weather like today')];
    const result = detectErrorSignal('tell me about quantum computing and physics', history);
    // Not similar enough
    expect(result).toBeNull();
  });

  test('excludes current message from history comparison', () => {
    const currentText = 'a completely different topic about something new and long enough';
    const history = [msg(currentText)];
    // The current message appears in history but should be excluded
    const result = detectErrorSignal(currentText, history);
    // Should not detect repetition because the identical message is excluded
    expect(result).toBeNull();
  });

  // ─── No signal ────────────────────────────────────────
  test('returns null for normal messages', () => {
    expect(detectErrorSignal('hello how are you today doing fine', [])).toBeNull();
    expect(detectErrorSignal('please help me write a function', [])).toBeNull();
  });
});
