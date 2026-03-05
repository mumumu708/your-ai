import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import { detectErrorSignal } from '../../lessons/error-detector';
import { extractLesson } from '../../lessons/lesson-extractor';
import type { LessonsLearnedUpdater } from '../../lessons/lessons-updater';

const ANALYSIS_TIMEOUT_MS = 3000;

export interface PostResponseAnalyzerDeps {
  lessonsUpdater: LessonsLearnedUpdater;
}

export class PostResponseAnalyzer {
  private readonly logger = new Logger('PostResponseAnalyzer');
  private readonly lessonsUpdater: LessonsLearnedUpdater;

  constructor(deps: PostResponseAnalyzerDeps) {
    this.lessonsUpdater = deps.lessonsUpdater;
  }

  async analyzeExchange(
    userId: string,
    userMsg: string,
    assistantMsg: string,
    history: ConversationMessage[],
  ): Promise<string | null> {
    try {
      const result = await this.withTimeout(
        this.doAnalyze(userId, userMsg, assistantMsg, history),
        ANALYSIS_TIMEOUT_MS,
      );
      return result;
    } catch (error) {
      this.logger.warn('响应分析超时或失败', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async doAnalyze(
    userId: string,
    userMsg: string,
    _assistantMsg: string,
    history: ConversationMessage[],
  ): Promise<string | null> {
    // Detect error signal from user message
    const signal = detectErrorSignal(userMsg, history);

    if (!signal || signal.confidence < 0.6) {
      return null;
    }

    this.logger.info('检测到用户纠正', {
      userId,
      type: signal.type,
      confidence: signal.confidence,
    });

    // Extract and store lesson
    const lesson = await extractLesson(signal);
    const added = await this.lessonsUpdater.addLesson(lesson);

    if (!added) return null;

    // Return confirmation to user
    switch (signal.category) {
      case 'preference':
        return `我记住了：${signal.text}`;
      case 'instruction':
        return `好的，我记住了：${signal.text}`;
      case 'fact':
        return `已记录：${signal.text}`;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
      ),
    ]);
  }
}
