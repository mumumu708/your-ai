import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

const logger = new Logger('EvolutionReflect');

/**
 * Reflect operation: loads same-category memory abstracts,
 * uses Claude to extract high-level insights, writes to semantic/.
 */
export async function reflect(ov: OpenVikingClient, category: string): Promise<void> {
  const memories = await ov.find({
    query: `所有 ${category} 类记忆`,
    target_uri: `viking://user/memories/${category}`,
    limit: 50,
  });

  if (memories.length < 5) return;

  const abstracts = await Promise.all(memories.map((m) => ov.abstract(m.uri)));

  const claude = new Anthropic();
  const message = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `分析以下 ${abstracts.length} 条记忆摘要，提炼 2-3 条高层洞察。
每条洞察用一行输出，格式为 "- 洞察: ..."

${abstracts.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
      },
    ],
  });

  const firstBlock = message.content[0];
  const text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
  const insights = text.split('\n').filter((line: string) => line.startsWith('- '));

  for (const insight of insights) {
    const content = insight.replace(/^- 洞察:\s*/, '');
    const slug = content
      .slice(0, 50)
      .replace(/\s+/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '');
    await ov.write(`viking://user/memories/semantic/${slug}`, content);
  }

  logger.info('反思完成', { category, insights: insights.length });
}
