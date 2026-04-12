import { Logger } from '../../shared/logging/logger';
import { estimateTokens } from './prompt-types';

const MAX_LINES = 200;
const MAX_TOKENS = 800;

interface MemoryItem {
  content: string;
  category?: 'preference' | 'fact' | 'context';
}

/**
 * Generates MEMORY.md snapshot content for L5 of the frozen system prompt.
 *
 * Placeholder implementation — full OpenViking integration comes in DD-012.
 * Currently accepts pre-fetched memory items and formats them into sections.
 */
export class MemorySnapshotBuilder {
  private readonly logger = new Logger('MemorySnapshotBuilder');

  /**
   * Build a memory snapshot from high-importance memories.
   * Groups by category, truncates to budget.
   */
  build(memories: MemoryItem[]): string {
    if (memories.length === 0) {
      this.logger.debug('No memories provided, returning empty snapshot');
      return '';
    }

    const grouped = this.groupByCategory(memories);
    const parts: string[] = ['# Memory Snapshot'];

    if (grouped.preference.length > 0) {
      parts.push('');
      parts.push('## 用户偏好');
      for (const m of grouped.preference.slice(0, 5)) {
        parts.push(`- ${m.content}`);
      }
    }

    if (grouped.fact.length > 0) {
      parts.push('');
      parts.push('## 关键事实');
      for (const m of grouped.fact.slice(0, 5)) {
        parts.push(`- ${m.content}`);
      }
    }

    if (grouped.context.length > 0) {
      parts.push('');
      parts.push('## 项目上下文');
      for (const m of grouped.context.slice(0, 5)) {
        parts.push(`- ${m.content}`);
      }
    }

    const content = parts.join('\n');
    return this.truncate(content);
  }

  private groupByCategory(memories: MemoryItem[]): {
    preference: MemoryItem[];
    fact: MemoryItem[];
    context: MemoryItem[];
  } {
    const result = {
      preference: [] as MemoryItem[],
      fact: [] as MemoryItem[],
      context: [] as MemoryItem[],
    };

    for (const m of memories) {
      const cat = m.category ?? 'fact';
      result[cat].push(m);
    }

    return result;
  }

  private truncate(content: string): string {
    // Line limit
    const lines = content.split('\n');
    let truncated = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') : content;

    // Token limit
    while (estimateTokens(truncated) > MAX_TOKENS && truncated.length > 0) {
      const lineArr = truncated.split('\n');
      lineArr.pop();
      truncated = lineArr.join('\n');
    }

    return truncated;
  }
}
