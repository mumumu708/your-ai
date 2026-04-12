import { Logger } from '../../shared/logging/logger';
import { estimateTokens } from './prompt-types';

const logger = new Logger('MemorySnapshotBuilder');
const MAX_LINES = 200;
const MAX_TOKENS = 800;

export interface MemoryItem {
  content: string;
  category?: 'preference' | 'fact' | 'context';
}

/**
 * Generates MEMORY.md snapshot content for L5 of the frozen system prompt.
 *
 * Placeholder implementation — full OpenViking integration comes in DD-012.
 * Currently accepts pre-fetched memory items and formats them into sections.
 */
export function buildMemorySnapshot(memories: MemoryItem[]): string {
  if (memories.length === 0) {
    logger.debug('No memories provided, returning empty snapshot');
    return '';
  }

  const grouped = groupByCategory(memories);
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
  return truncateSnapshot(content);
}

function groupByCategory(memories: MemoryItem[]): {
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

function truncateSnapshot(content: string): string {
  const lines = content.split('\n');
  let truncated = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') : content;

  while (estimateTokens(truncated) > MAX_TOKENS && truncated.length > 0) {
    const lineArr = truncated.split('\n');
    lineArr.pop();
    truncated = lineArr.join('\n');
  }

  return truncated;
}
