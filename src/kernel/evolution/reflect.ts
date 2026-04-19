import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

const logger = new Logger('EvolutionReflect');

/** Optional LLM call for reflection — allows injecting LightLLM as alternative to Anthropic SDK */
export type ReflectLlmCall = (prompt: string) => Promise<string>;

/**
 * Reflect operation: loads same-category memory abstracts,
 * uses an LLM to extract high-level insights, writes to semantic/.
 *
 * If `llmCall` is not provided, falls back to Anthropic SDK (requires ANTHROPIC_API_KEY).
 * If ANTHROPIC_API_KEY is not set either, silently skips reflection.
 */
export async function reflect(
  ov: OpenVikingClient,
  category: string,
  llmCall?: ReflectLlmCall,
): Promise<void> {
  const memories = await ov.find({
    query: `所有 ${category} 类记忆`,
    target_uri: `viking://user/default/memories/${category}`,
    limit: 50,
  });

  if (memories.length < 5) return;

  // abstract() only works on directories — memory URIs from find() are .md files
  const abstracts = await Promise.all(
    memories.map(async (m) => (await ov.read(m.uri)).slice(0, 300)),
  );

  const prompt = `分析以下 ${abstracts.length} 条记忆摘要，提炼 2-3 条高层洞察。
每条洞察用一行输出，格式为 "- 洞察: ..."

${abstracts.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;

  let text: string;
  if (llmCall) {
    text = await llmCall(prompt);
  } else {
    // Fallback: Anthropic SDK (requires ANTHROPIC_API_KEY)
    if (!process.env.ANTHROPIC_API_KEY) {
      logger.info('跳过反思 — 未配置 ANTHROPIC_API_KEY 且未注入 llmCall', { category });
      return;
    }
    const claude = new Anthropic();
    const message = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const firstBlock = message.content[0];
    text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
  }

  const insights = text.split('\n').filter((line: string) => line.startsWith('- '));

  for (const insight of insights) {
    const content = insight.replace(/^- 洞察:\s*/, '');
    const slug = content
      .slice(0, 50)
      .replace(/\s+/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '');
    await ov.write(`viking://user/default/memories/semantic/${slug}`, content);
  }

  logger.info('反思完成', { category, insights: insights.length });
}
