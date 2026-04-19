import type { IConfigLoader } from '../../../shared/memory/memory.interfaces';
import type { LessonsLearnedUpdater } from './lessons-updater';

/**
 * Natural-language commands for manual lesson management.
 * Supports: "记住:...", "查看教训", "remember:...", "show lessons"
 */

const REMEMBER_PATTERNS = [/^记住[：:]\s*(.+)$/, /^remember[：:]\s*(.+)$/i];

const VIEW_PATTERNS = [/^查看教训$/, /^show lessons$/i, /^list lessons$/i];

export interface ManualCommandResult {
  handled: boolean;
  response?: string;
}

export async function handleManualCommand(
  message: string,
  updater: LessonsLearnedUpdater,
  configLoader: IConfigLoader,
): Promise<ManualCommandResult> {
  const trimmed = message.trim();

  // "记住:..." or "remember:..."
  for (const pattern of REMEMBER_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) {
      const lesson = match[1].trim();
      const added = await updater.addLesson({
        action: lesson,
        category: 'instruction',
        lesson,
      });
      return {
        handled: true,
        response: added ? `已记住：${lesson}` : '已有类似教训，无需重复记录',
      };
    }
  }

  // "查看教训" or "show lessons"
  for (const pattern of VIEW_PATTERNS) {
    if (pattern.test(trimmed)) {
      const lessons = await configLoader.getLessonsLearned();
      return {
        handled: true,
        response: lessons || '暂无教训记录',
      };
    }
  }

  return { handled: false };
}
