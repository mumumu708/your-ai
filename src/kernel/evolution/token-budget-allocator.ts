import type { KnowledgeFragment, KnowledgeSource } from './evolution-types';

const CHARS_PER_TOKEN = 4;

type BucketKey = 'identity' | 'memory' | 'session';

const SOURCE_TO_BUCKET: Record<KnowledgeSource, BucketKey> = {
  identity: 'identity',
  soul: 'identity',
  user: 'identity',
  memory: 'memory',
  session: 'session',
  workspace: 'session',
};

export interface BudgetRatios {
  identity: number;
  memory: number;
  session: number;
}

export const DEFAULT_BUDGET_RATIOS: BudgetRatios = {
  identity: 0.3,
  memory: 0.5,
  session: 0.2,
};

export class TokenBudgetAllocator {
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  trimFragment(fragment: KnowledgeFragment, maxTokens: number): KnowledgeFragment {
    if (fragment.tokens <= maxTokens) return fragment;

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const content = fragment.content;

    // Try to trim at sentence boundary
    let trimPoint = maxChars;
    const sentenceEnders = ['. ', '。', '！', '？', '! ', '? ', '\n'];
    let bestBreak = -1;

    for (const ender of sentenceEnders) {
      const idx = content.lastIndexOf(ender, maxChars);
      if (idx > 0 && idx > bestBreak) {
        bestBreak = idx + ender.length;
      }
    }

    if (bestBreak > maxChars * 0.5) {
      trimPoint = bestBreak;
    }

    const trimmedContent = content.slice(0, trimPoint);
    return {
      ...fragment,
      content: trimmedContent,
      tokens: this.estimateTokens(trimmedContent),
    };
  }

  allocate(
    fragments: KnowledgeFragment[],
    budget: number,
    ratios: BudgetRatios = DEFAULT_BUDGET_RATIOS,
  ): KnowledgeFragment[] {
    if (fragments.length === 0) return [];

    // Distribute fragments into buckets
    const buckets: Record<BucketKey, KnowledgeFragment[]> = {
      identity: [],
      memory: [],
      session: [],
    };

    for (const fragment of fragments) {
      const bucket = SOURCE_TO_BUCKET[fragment.source];
      buckets[bucket].push(fragment);
    }

    // Sort each bucket by priority descending
    for (const key of Object.keys(buckets) as BucketKey[]) {
      buckets[key].sort((a, b) => b.priority - a.priority);
    }

    // Calculate initial budgets
    const bucketBudgets: Record<BucketKey, number> = {
      identity: Math.floor(budget * ratios.identity),
      memory: Math.floor(budget * ratios.memory),
      session: Math.floor(budget * ratios.session),
    };

    // Fill each bucket, track unused budget
    const result: KnowledgeFragment[] = [];
    let unusedBudget = 0;
    const bucketKeys: BucketKey[] = ['identity', 'memory', 'session'];
    const pendingBuckets: { key: BucketKey; remaining: KnowledgeFragment[] }[] = [];

    for (const key of bucketKeys) {
      const { selected, remaining, unused } = this.fillBucket(
        buckets[key],
        bucketBudgets[key],
      );
      result.push(...selected);
      unusedBudget += unused;

      if (remaining.length > 0) {
        pendingBuckets.push({ key, remaining });
      }
    }

    // Redistribute unused budget to pending buckets
    if (unusedBudget > 0 && pendingBuckets.length > 0) {
      for (const { remaining } of pendingBuckets) {
        if (unusedBudget <= 0) break;

        const { selected, unused } = this.fillBucket(remaining, unusedBudget);
        result.push(...selected);
        unusedBudget = unused;
      }
    }

    return result;
  }

  private fillBucket(
    fragments: KnowledgeFragment[],
    budget: number,
  ): {
    selected: KnowledgeFragment[];
    remaining: KnowledgeFragment[];
    unused: number;
  } {
    const selected: KnowledgeFragment[] = [];
    const remaining: KnowledgeFragment[] = [];
    let used = 0;

    for (const fragment of fragments) {
      if (used + fragment.tokens <= budget) {
        selected.push(fragment);
        used += fragment.tokens;
      } else {
        const available = budget - used;
        if (available > 10) {
          // Trim and include partial fragment
          const trimmed = this.trimFragment(fragment, available);
          if (trimmed.tokens > 0) {
            selected.push(trimmed);
            used += trimmed.tokens;
          }
        }
        remaining.push(fragment);
      }
    }

    return { selected, remaining, unused: budget - used };
  }
}
