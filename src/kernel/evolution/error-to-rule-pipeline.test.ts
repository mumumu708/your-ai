import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ErrorSignal } from '../../lessons/error-detector';
import type { LessonsLearnedUpdater } from '../../lessons/lessons-updater';
import { ErrorToRulePipeline } from './error-to-rule-pipeline';

describe('ErrorToRulePipeline', () => {
  let pipeline: ErrorToRulePipeline;
  let lessonsUpdater: LessonsLearnedUpdater;
  let logSpy: ReturnType<typeof spyOn>;
  let addedLessons: Array<{ lesson: string; category: string }>;

  beforeEach(async () => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    addedLessons = [];

    lessonsUpdater = {
      addLesson: async (lesson: any) => {
        addedLessons.push({ lesson: lesson.lesson, category: lesson.category });
        return true;
      },
    } as any;

    pipeline = new ErrorToRulePipeline(lessonsUpdater);
  });

  test('应该将 preference 类信号写入教训', async () => {
    const signal: ErrorSignal = {
      type: 'correction',
      text: '请给出详细解释',
      confidence: 0.8,
      category: 'preference',
    };

    const result = await pipeline.processErrorSignal('user1', signal);

    expect(result).toContain('记住了');
    expect(addedLessons.length).toBeGreaterThanOrEqual(1);
    logSpy.mockRestore();
  });

  test('应该将 instruction 类信号写入教训', async () => {
    const signal: ErrorSignal = {
      type: 'correction',
      text: '应该先验证输入',
      confidence: 0.8,
      category: 'instruction',
    };

    const result = await pipeline.processErrorSignal('user1', signal);

    expect(result).toContain('记住了');
    expect(addedLessons.length).toBe(1);
    logSpy.mockRestore();
  });

  test('fact 类信号应该记录', async () => {
    const signal: ErrorSignal = {
      type: 'correction',
      text: '项目名叫 alpha',
      confidence: 0.8,
      category: 'fact',
    };

    const result = await pipeline.processErrorSignal('user1', signal);

    expect(result).toContain('已记录');
    expect(addedLessons.length).toBe(1);
    logSpy.mockRestore();
  });

  test('重复教训应该跳过写入', async () => {
    const duplicateUpdater = {
      addLesson: async () => false, // indicates duplicate
    } as any;

    const dupPipeline = new ErrorToRulePipeline(duplicateUpdater);

    const signal: ErrorSignal = {
      type: 'correction',
      text: '请给出详细解释',
      confidence: 0.8,
      category: 'preference',
    };

    const result = await dupPipeline.processErrorSignal('user1', signal);

    expect(result).toContain('已存在');
    logSpy.mockRestore();
  });
});
