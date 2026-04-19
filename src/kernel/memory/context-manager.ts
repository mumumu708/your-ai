import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from './openviking/openviking-client';

/**
 * Pre-Compaction Memory Flush manager.
 * When conversation tokens exceed the flush threshold (80% of max),
 * commits the session to OpenViking and returns anchor text
 * summarizing key memories for context continuity.
 */
export class ContextManager {
  private readonly logger = new Logger('ContextManager');

  constructor(
    private readonly ov: OpenVikingClient,
    private readonly maxTokens = 128_000,
    private readonly flushThreshold = 0.8,
  ) {}

  /**
   * Check if token usage exceeds threshold; if so, commit session
   * and return anchor text for post-compaction context.
   * Returns null if no flush needed.
   */
  async checkAndFlush(sessionId: string, currentTokens: number): Promise<string | null> {
    if (currentTokens / this.maxTokens < this.flushThreshold) {
      return null;
    }

    this.logger.info('Pre-Compaction 触发', {
      sessionId,
      currentTokens,
      threshold: this.maxTokens * this.flushThreshold,
    });

    // Commit current session to extract memories before compaction
    await this.ov.commit(sessionId);

    // Retrieve key memories to build anchor text
    const keyMemories = await this.ov.find({
      query: '当前会话关键信息',
      target_uri: 'viking://user/default/memories',
      limit: 10,
    });

    // abstract() only works on directories — memory URIs are .md files, use read()
    const abstracts = await Promise.all(
      keyMemories.map(async (m) => (await this.ov.read(m.uri)).slice(0, 200)),
    );

    const anchor = ['## 关键记忆（上下文压缩后保留）', ...abstracts.map((a) => `- ${a}`)].join(
      '\n',
    );

    this.logger.info('Pre-Compaction 完成', {
      sessionId,
      anchorMemories: abstracts.length,
    });

    return anchor;
  }
}
