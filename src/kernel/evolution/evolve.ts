import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

const logger = new Logger('EvolutionEvolve');

type EvolutionRelation = 'SUPERSEDE' | 'SUPPLEMENT' | 'CONTRADICT' | 'DUPLICATE';

/**
 * Evolve operation: LLM classifies the relationship between new content
 * and an existing memory, then takes the appropriate action.
 */
export async function evolveMemory(
  ov: OpenVikingClient,
  newContent: string,
  existingUri: string,
): Promise<void> {
  const existing = await ov.read(existingUri);

  const claude = new Anthropic();
  const message = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `对比两条记忆，输出一个词表示关系：
已有：${existing}
新增：${newContent}

SUPERSEDE（新替代旧）| SUPPLEMENT（新补充旧）| CONTRADICT（矛盾需合并）| DUPLICATE（重复跳过）`,
      },
    ],
  });

  const firstBlock = message.content[0];
  const rawRelation =
    firstBlock && firstBlock.type === 'text' ? firstBlock.text.trim() : 'DUPLICATE';
  const relation = parseRelation(rawRelation);

  switch (relation) {
    case 'SUPERSEDE':
      await ov.write(existingUri, newContent);
      logger.info('记忆替代', { uri: existingUri });
      break;
    case 'SUPPLEMENT': {
      const merged = `${existing}\n\n---\n${newContent}`;
      await ov.write(existingUri, merged);
      logger.info('记忆补充', { uri: existingUri });
      break;
    }
    case 'CONTRADICT': {
      const resolved = `[合并解决矛盾]\n旧：${existing}\n新：${newContent}\n结论：以新信息为准`;
      await ov.write(existingUri, resolved);
      logger.info('记忆矛盾已解决', { uri: existingUri });
      break;
    }
    case 'DUPLICATE':
      logger.debug('重复记忆，跳过', { uri: existingUri });
      break;
  }
}

function parseRelation(text: string): EvolutionRelation {
  const upper = text.toUpperCase();
  if (upper.includes('SUPERSEDE')) return 'SUPERSEDE';
  if (upper.includes('SUPPLEMENT')) return 'SUPPLEMENT';
  if (upper.includes('CONTRADICT')) return 'CONTRADICT';
  return 'DUPLICATE';
}
