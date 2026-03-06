import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

const logger = new Logger('EvolutionLink');

/**
 * Link operation: finds similar memories via ov.search(),
 * creates VikingFS links for pairs with score > 0.75.
 */
export async function linkMemory(ov: OpenVikingClient, newMemoryUri: string): Promise<void> {
  const content = await ov.abstract(newMemoryUri);

  const similar = await ov.search({
    query: content,
    target_uri: 'viking://user/memories',
    limit: 5,
  });

  let linked = 0;
  for (const result of similar) {
    if (result.score > 0.75 && result.uri !== newMemoryUri) {
      await ov.link(newMemoryUri, [result.uri], `semantic_similarity:${result.score.toFixed(2)}`);
      linked++;
    }
  }

  if (linked > 0) {
    logger.info('关联发现', { uri: newMemoryUri, linked });
  }
}
