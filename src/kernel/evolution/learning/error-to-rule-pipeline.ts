import { Logger } from '../../../shared/logging/logger';
import type { ErrorSignal } from './error-detector';
import { extractLesson } from './lesson-extractor';
import type { LessonsLearnedUpdater } from './lessons-updater';

/**
 * Error-to-Rule pipeline: delegates to the new Lessons Learned system.
 * Converts detected error signals into lessons stored in SOUL.md.
 */
export class ErrorToRulePipeline {
  private readonly logger = new Logger('ErrorToRulePipeline');

  constructor(private readonly lessonsUpdater: LessonsLearnedUpdater) {}

  async processErrorSignal(userId: string, signal: ErrorSignal): Promise<string> {
    const lesson = await extractLesson(signal);

    const added = await this.lessonsUpdater.addLesson(lesson);

    if (!added) {
      this.logger.info('教训已存在，跳过', { userId });
      return '已存在类似教训，无需重复记录';
    }

    this.logger.info('教训已记录', {
      userId,
      category: lesson.category,
      lesson: lesson.lesson.slice(0, 40),
    });

    return this.buildConfirmation(signal);
  }

  private buildConfirmation(signal: ErrorSignal): string {
    switch (signal.category) {
      case 'preference':
        return `我记住了：${signal.text}`;
      case 'instruction':
        return `好的，我记住了：${signal.text}`;
      case 'fact':
        return `已记录：${signal.text}`;
    }
  }
}
