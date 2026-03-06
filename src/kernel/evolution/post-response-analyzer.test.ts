import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { LessonsLearnedUpdater } from '../../lessons/lessons-updater';
import { PostResponseAnalyzer } from './post-response-analyzer';

describe('PostResponseAnalyzer', () => {
  let analyzer: PostResponseAnalyzer;
  let lessonsUpdater: LessonsLearnedUpdater;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});

    lessonsUpdater = {
      addLesson: async () => true,
    } as unknown as LessonsLearnedUpdater;

    analyzer = new PostResponseAnalyzer({
      lessonsUpdater,
    });
  });

  test('检测到纠正时应该返回确认文本', async () => {
    const result = await analyzer.analyzeExchange(
      'user1',
      '不对，我要的是详细解释',
      'Current response',
      [
        { role: 'user', content: '帮我解释一下', timestamp: Date.now() - 2000 },
        { role: 'assistant', content: '简短回答', timestamp: Date.now() - 1000 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result).toContain('记住了');
    logSpy.mockRestore();
  });

  test('无纠正时应该返回 null', async () => {
    const result = await analyzer.analyzeExchange('user1', '谢谢你的回答', 'You are welcome', []);

    expect(result).toBeNull();
    logSpy.mockRestore();
  });

  test('低置信度纠正应该返回 null', async () => {
    // Normal messages without correction patterns should not trigger
    const result = await analyzer.analyzeExchange('user1', '好的，我知道了', 'response', []);

    expect(result).toBeNull();
    logSpy.mockRestore();
  });

  test('addLesson 失败时应该返回 null', async () => {
    const failingUpdater = {
      addLesson: async () => false, // indicates duplicate, lesson not added
    } as unknown as LessonsLearnedUpdater;

    const customAnalyzer = new PostResponseAnalyzer({
      lessonsUpdater: failingUpdater,
    });

    const result = await customAnalyzer.analyzeExchange(
      'user1',
      '不对，应该用TypeScript',
      'Here is JavaScript',
      [{ role: 'assistant', content: 'Previous JS', timestamp: Date.now() - 1000 }],
    );

    expect(result).toBeNull();
    logSpy.mockRestore();
  });

  test('管道异常时应该返回 null', async () => {
    const errorUpdater = {
      addLesson: async () => {
        throw new Error('DB error');
      },
    } as unknown as LessonsLearnedUpdater;

    const customAnalyzer = new PostResponseAnalyzer({
      lessonsUpdater: errorUpdater,
    });

    const result = await customAnalyzer.analyzeExchange(
      'user1',
      '不对，应该用TypeScript',
      'Here is JavaScript',
      [{ role: 'assistant', content: 'Previous JS', timestamp: Date.now() - 1000 }],
    );

    expect(result).toBeNull();
    logSpy.mockRestore();
  });
});
