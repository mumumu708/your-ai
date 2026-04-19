import { Logger } from '../../../shared/logging/logger';
import type { OpenVikingClient } from '../../memory/openviking/openviking-client';

const logger = new Logger('DigestPipeline');
const MIN_CLUSTER_SIZE = 3;
const SIMILARITY_THRESHOLD = 0.6;

export interface DigestInput {
  /** Memory items to digest */
  items: DigestableItem[];
}

export interface DigestableItem {
  uri: string;
  content: string;
  importance: number;
  accessCount: number;
}

export interface DigestCluster {
  topic: string;
  items: DigestableItem[];
}

export interface DigestInsight {
  topic: string;
  insight: string;
  questions: string[];
  relatedSkills: string[];
  sourceUris: string[];
}

export type LlmDistillFn = (clusterContent: string) => Promise<DigestInsight>;

/**
 * Phase 1: Scan — collect undigested memory fragments.
 */
export async function scanUndigested(
  ovClient: OpenVikingClient,
  userId: string,
): Promise<DigestableItem[]> {
  const results = await ovClient.find({
    query: '*',
    target_uri: `viking://mem/${userId}`,
    limit: 100,
  });

  return results
    .filter((m) => m.score < 0.5)
    .map((m) => ({
      uri: m.uri,
      content: m.abstract,
      importance: m.score,
      accessCount: 0,
    }));
}

/**
 * Phase 2: Cluster — group similar items using vector similarity via OpenViking.
 *
 * For each unassigned item, queries OV to find similar items from the pool.
 * Falls back to keyword-based clustering when OV is unavailable.
 */
export async function clusterItemsWithOV(
  items: DigestableItem[],
  ovClient: OpenVikingClient,
): Promise<DigestCluster[]> {
  if (items.length < MIN_CLUSTER_SIZE) return [];

  const assigned = new Set<string>();
  const clusters: DigestCluster[] = [];

  for (const item of items) {
    if (assigned.has(item.uri)) continue;

    // Use this item's content as query to find similar items via vector search
    const similar = await ovClient.find({
      query: item.content,
      target_uri: 'viking://mem/',
      limit: 20,
      score_threshold: SIMILARITY_THRESHOLD,
    });

    // Collect items from our pool that matched
    const clusterItems: DigestableItem[] = [item];
    assigned.add(item.uri);

    const poolUris = new Set(items.map((i) => i.uri));
    for (const match of similar) {
      if (!assigned.has(match.uri) && poolUris.has(match.uri)) {
        const poolItem = items.find((i) => i.uri === match.uri);
        if (poolItem) {
          clusterItems.push(poolItem);
          assigned.add(match.uri);
        }
      }
    }

    if (clusterItems.length >= MIN_CLUSTER_SIZE) {
      clusters.push({
        topic: extractTopic(item.content),
        items: clusterItems,
      });
    }
  }

  return clusters;
}

/**
 * Phase 2 fallback: Keyword-based clustering (no OV dependency).
 * Groups items by their first significant word.
 */
export function clusterItems(items: DigestableItem[]): DigestCluster[] {
  if (items.length < MIN_CLUSTER_SIZE) return [];

  const clusters = new Map<string, DigestableItem[]>();

  for (const item of items) {
    const topic = extractTopic(item.content);
    if (!clusters.has(topic)) clusters.set(topic, []);
    clusters.get(topic)?.push(item);
  }

  return Array.from(clusters.entries())
    .filter(([, items]) => items.length >= MIN_CLUSTER_SIZE)
    .map(([topic, items]) => ({ topic, items }));
}

/**
 * Phase 3: Distill — generate insights from clusters via LLM.
 */
export async function distillClusters(
  clusters: DigestCluster[],
  llmDistill: LlmDistillFn,
): Promise<DigestInsight[]> {
  const insights: DigestInsight[] = [];

  for (const cluster of clusters) {
    const content = cluster.items.map((i) => i.content).join('\n---\n');
    try {
      const insight = await llmDistill(content);
      insight.sourceUris = cluster.items.map((i) => i.uri);
      insights.push(insight);
      logger.info('Cluster 提炼完成', { topic: cluster.topic, itemCount: cluster.items.length });
    } catch (err) {
      logger.warn('Cluster 提炼失败', { topic: cluster.topic, error: String(err) });
    }
  }

  return insights;
}

/**
 * Phase 4: Surface — write insights back to OpenViking and mark sources as digested.
 */
export async function writeInsights(
  ovClient: OpenVikingClient,
  userId: string,
  insights: DigestInsight[],
): Promise<number> {
  let written = 0;

  for (const insight of insights) {
    const uri = `viking://mem/${userId}/insight/${insight.topic.replace(/\s+/g, '-')}`;
    await ovClient.write(uri, insight.insight);
    written++;
  }

  logger.info('Digest insights 写入完成', { count: written, userId });
  return written;
}

function extractTopic(content: string): string {
  const cleaned = content.replace(/[^\w\u4e00-\u9fff]/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  return words[0] || 'misc';
}
