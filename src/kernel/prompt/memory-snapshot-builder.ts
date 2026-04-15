import { Logger } from '../../shared/logging/logger';
import type { MemoryCategory } from '../memory/memory-types';
import { estimateTokens } from './prompt-types';

const logger = new Logger('MemorySnapshotBuilder');
const MAX_LINES = 200;
const MAX_TOKENS = 800;

export interface MemoryItem {
  content: string;
  category?: MemoryCategory;
  importance?: number; // 0-1
  updatedAt?: number; // timestamp
  accessCount?: number; // retrieval hit count
}

interface ScoredItem extends MemoryItem {
  score: number;
}

const CATEGORY_CONFIG: Record<string, { label: string; maxItems: number }> = {
  preference: { label: '用户偏好', maxItems: 5 },
  fact: { label: '关键事实', maxItems: 5 },
  context: { label: '项目上下文', maxItems: 4 },
  instruction: { label: '行为指令', maxItems: 3 },
  insight: { label: '总结洞察', maxItems: 3 },
  task: { label: '活跃任务', maxItems: 3 },
};

/**
 * Generates MEMORY.md snapshot content for L5 of the frozen system prompt.
 *
 * Covers all 6 MemoryCategory types, sorted by importance × recency scoring.
 * Constrained to ≤200 lines / ≤800 tokens.
 */
export function buildMemorySnapshot(memories: MemoryItem[]): string {
  if (memories.length === 0) {
    logger.debug('No memories provided, returning empty snapshot');
    return '';
  }

  // Score and sort
  const scored: ScoredItem[] = memories.map((m) => ({
    ...m,
    score: computeSnapshotScore(m),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Group by category
  const grouped = groupByCategory(scored);
  const parts: string[] = ['# Memory Snapshot'];

  for (const [cat, config] of Object.entries(CATEGORY_CONFIG)) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    parts.push('', `## ${config.label}`);
    for (const m of items.slice(0, config.maxItems)) {
      parts.push(`- ${m.content}`);
    }
  }

  const content = parts.join('\n');
  return truncateSnapshot(content);
}

/**
 * Computes a composite score for snapshot inclusion priority.
 * Higher score = more likely to be included.
 *
 * Formula: importance * 0.5 + recency * 0.3 + accessBonus * 0.2
 * - importance: direct value (0-1), default 0.5
 * - recency: exponential decay with 30-day half-life
 * - accessBonus: capped at 0.3 based on access count
 */
export function computeSnapshotScore(m: MemoryItem): number {
  const importance = m.importance ?? 0.5;
  const daysSinceUpdate = m.updatedAt ? (Date.now() - m.updatedAt) / 86_400_000 : 0;
  const recencyDecay = Math.exp(-daysSinceUpdate / 30);
  const accessBonus = Math.min((m.accessCount ?? 0) / 10, 0.3);
  return importance * 0.5 + recencyDecay * 0.3 + accessBonus * 0.2;
}

function groupByCategory(memories: ScoredItem[]): Record<string, ScoredItem[]> {
  const result: Record<string, ScoredItem[]> = {};

  for (const m of memories) {
    const cat = m.category ?? 'fact';
    if (!result[cat]) result[cat] = [];
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
