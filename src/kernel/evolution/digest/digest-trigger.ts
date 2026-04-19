import { Logger } from '../../../shared/logging/logger';

const logger = new Logger('DigestTrigger');

export interface DigestState {
  undigestedCount: number;
  lastDigestAt: number | null; // timestamp
}

export interface DigestTriggerConfig {
  minUndigested: number; // default 20
  minDaysSinceLastDigest: number; // default 3
}

const DEFAULT_CONFIG: DigestTriggerConfig = {
  minUndigested: 20,
  minDaysSinceLastDigest: 3,
};

/**
 * Determines whether a digest cycle should trigger.
 * Any single condition being met is sufficient to trigger.
 */
export function shouldTriggerDigest(
  state: DigestState,
  manualTrigger = false,
  config: DigestTriggerConfig = DEFAULT_CONFIG,
): boolean {
  if (manualTrigger) {
    logger.info('Digest 手动触发');
    return true;
  }

  if (state.undigestedCount >= config.minUndigested) {
    logger.info('Digest 触发：未消化碎片阈值', { count: state.undigestedCount });
    return true;
  }

  if (state.lastDigestAt !== null) {
    const daysSinceLast = (Date.now() - state.lastDigestAt) / 86_400_000;
    if (daysSinceLast >= config.minDaysSinceLastDigest) {
      logger.info('Digest 触发：时间阈值', { daysSinceLast: Math.floor(daysSinceLast) });
      return true;
    }
  }

  return false;
}
