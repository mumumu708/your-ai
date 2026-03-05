import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from './openviking/openviking-client';
import type { MatchedContext } from './openviking/types';

export interface RetrieveOptions {
  query: string;
  tokenBudget?: number; // default 4000
  memoryTopK?: number; // default 20
  resourceTopK?: number; // default 10
}

const logger = new Logger('MemoryRetrieverV2');

/** Returns true if the URI points to a file (has a file extension), false if directory. */
function isFileUri(uri: string): boolean {
  const lastSegment = uri.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

/**
 * Progressive L0→L1→L2 memory retrieval under a token budget.
 * Searches across memories + resources in parallel via OpenViking find().
 */
export async function retrieveMemories(
  ov: OpenVikingClient,
  options: RetrieveOptions,
): Promise<MatchedContext[]> {
  const {
    query,
    tokenBudget = 4000,
    memoryTopK = 20,
    resourceTopK = 10,
  } = options;

  // 1. Parallel search across memories and resources
  const [memoryResults, resourceResults] = await Promise.all([
    ov.find({
      query,
      target_uri: 'viking://user/memories',
      limit: memoryTopK,
    }),
    ov.find({
      query,
      target_uri: 'viking://resources',
      limit: resourceTopK,
    }),
  ]);

  // 2. Merge and sort by score descending
  const allResults = [...memoryResults, ...resourceResults].sort(
    (a, b) => b.score - a.score,
  );

  // 3. Progressive context loading under token budget
  const contextItems: MatchedContext[] = [];
  let remaining = tokenBudget;

  for (const result of allResults) {
    if (remaining <= 0) break;

    try {
      const isFile = isFileUri(result.uri);
      if (remaining > 2000) {
        // L1: overview (~500-2000 tokens)
        // overview/abstract only work on directories; use read() for file URIs
        const content = isFile ? await ov.read(result.uri) : await ov.overview(result.uri);
        contextItems.push({
          uri: result.uri,
          content,
          level: 'L1',
          score: result.score,
        });
        remaining -= 2000;
      } else if (remaining > 100) {
        // L0: abstract (~50-100 tokens)
        const content = isFile ? await ov.read(result.uri) : await ov.abstract(result.uri);
        contextItems.push({
          uri: result.uri,
          content,
          level: 'L0',
          score: result.score,
        });
        remaining -= 100;
      }
    } catch (err) {
      logger.warn('记忆加载失败', {
        uri: result.uri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('记忆检索完成', {
    query: query.slice(0, 50),
    candidates: allResults.length,
    loaded: contextItems.length,
    remainingBudget: remaining,
  });

  return contextItems;
}
