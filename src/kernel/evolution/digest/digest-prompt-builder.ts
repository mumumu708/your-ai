/**
 * Builds prompts for the digest LLM call.
 * Used by digest-pipeline Phase 3 (distill).
 */

export const DIGEST_SYSTEM_PROMPT = `你是一个知识消化助手。你的任务是将零散的信息碎片聚类、提炼为结构化洞察。

输出要求：
1. topic: 一个简洁的主题名称（2-5 个词）
2. insight: 提炼的洞察（1-3 段，精炼但完整）
3. questions: 值得深入探索的问题（0-3 个）
4. relatedSkills: 如果有相关的已知 skill，列出名称

输出格式为 JSON：
{
  "topic": "...",
  "insight": "...",
  "questions": ["..."],
  "relatedSkills": ["..."]
}`;

export function buildDigestPrompt(clusterContent: string): string {
  return `以下是一组相关的信息碎片，请提炼出核心洞察：

---
${clusterContent}
---

请按系统要求的 JSON 格式输出。`;
}
