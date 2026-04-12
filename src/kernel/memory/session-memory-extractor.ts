import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import type { SessionSummary } from './memory-types';

/**
 * Extracts structured memory from a completed session's messages.
 * Uses rule-based extraction (no LLM dependency).
 * Can be enhanced with LLM-based extraction via the optional llmExtract callback.
 */

export type LlmExtractFn = (prompt: string) => Promise<string>;

// Patterns for identifying actionable items
const ACTION_ITEM_PATTERNS = [
  /(?:帮我|请|需要|要|得)(.{5,40})/g,
  /(?:TODO|todo|待办|记得|别忘)[:：]?\s*(.{5,60})/g,
  /(?:please|should|need to|have to|must)\s+(.{5,60})/gi,
];

// Patterns for discovering user preferences
const PREFERENCE_PATTERNS = [
  /(?:我喜欢|我偏好|我习惯|我一般|我通常)(.{3,40})/g,
  /(?:不要|别|不想|不喜欢)(.{3,40})/g,
  /(?:i (?:prefer|like|always|usually|want))(.{3,60})/gi,
  /(?:don't|do not|never)\s+(.{3,60})/gi,
];

// Keyword extraction: CJK and English
const KEYWORD_STOP_WORDS = new Set([
  '的',
  '了',
  '是',
  '在',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '个',
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'be',
  'to',
  'of',
  'and',
  'in',
  'that',
  'it',
  'for',
  'on',
  'with',
  'as',
  'at',
  'this',
  'but',
  'not',
  'you',
  'from',
  'i',
  'me',
  'my',
  'we',
  'he',
  'she',
  'they',
]);

export class SessionMemoryExtractor {
  private readonly logger = new Logger('SessionMemoryExtractor');
  private llmExtract: LlmExtractFn | null = null;

  setLlmExtract(fn: LlmExtractFn): void {
    this.llmExtract = fn;
  }

  async extract(
    sessionId: string,
    userId: string,
    messages: ConversationMessage[],
  ): Promise<SessionSummary> {
    if (messages.length === 0) {
      return this.emptySummary(sessionId, userId);
    }

    const startedAt = messages[0]?.timestamp;
    const endedAt = messages[messages.length - 1]?.timestamp;

    // Combine all user content for analysis
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');

    const allContent = messages.map((m) => m.content).join('\n');

    const keywords = this.extractKeywords(allContent);
    const actionItems = this.extractPatterns(userContent, ACTION_ITEM_PATTERNS);
    const preferences = this.extractPatterns(userContent, PREFERENCE_PATTERNS);

    // Build summary from first user message + topic keywords
    let summary = this.buildRuleSummary(messages, keywords);

    // Optional LLM enhancement
    if (this.llmExtract && messages.length >= 5) {
      try {
        const llmSummary = await this.llmExtractSummary(messages);
        if (llmSummary) summary = llmSummary;
      } catch (error) {
        this.logger.warn('LLM摘要提取失败，使用规则摘要', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info('会话记忆提取完成', {
      sessionId,
      messageCount: messages.length,
      keywords: keywords.length,
      actionItems: actionItems.length,
      preferences: preferences.length,
    });

    return {
      sessionId,
      userId,
      summary,
      keywords,
      actionItems,
      preferences,
      messageCount: messages.length,
      startedAt,
      endedAt,
    };
  }

  /**
   * Extract keywords using term frequency.
   */
  extractKeywords(text: string, topK = 10): string[] {
    // Tokenize: split on whitespace and CJK boundaries
    const tokens = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !KEYWORD_STOP_WORDS.has(t));

    // Count frequency
    const freq = new Map<string, number>();
    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }

    // Sort by frequency descending
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([word]) => word);
  }

  /**
   * Extract patterns from text using regex groups.
   */
  extractPatterns(text: string, patterns: RegExp[]): string[] {
    const results = new Set<string>();

    for (const pattern of patterns) {
      // Reset regex state
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null = regex.exec(text);
      while (match !== null) {
        const captured = (match[1] ?? match[0]).trim();
        if (captured.length >= 3) {
          results.add(captured);
        }
        match = regex.exec(text);
      }
    }

    return Array.from(results);
  }

  private buildRuleSummary(messages: ConversationMessage[], keywords: string[]): string {
    const firstUserMsg = messages.find((m) => m.role === 'user');
    const topicStr = keywords.slice(0, 5).join('、');

    const parts: string[] = [];

    if (firstUserMsg) {
      // Truncate first message to ~100 chars
      const truncated =
        firstUserMsg.content.length > 100
          ? `${firstUserMsg.content.slice(0, 100)}...`
          : firstUserMsg.content;
      parts.push(truncated);
    }

    if (topicStr) {
      parts.push(`关键词: ${topicStr}`);
    }

    parts.push(`共${messages.length}轮对话`);

    return parts.join(' | ');
  }

  private async llmExtractSummary(messages: ConversationMessage[]): Promise<string | null> {
    if (!this.llmExtract) return null;

    // Build a compact transcript
    const transcript = messages
      .slice(-20) // Last 20 messages max
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.slice(0, 200)}`)
      .join('\n');

    const prompt = `请用100字内概括以下对话的核心内容，包括讨论主题和关键结论：\n\n${transcript}`;

    const result = await this.llmExtract(prompt);
    return result.trim() || null;
  }

  private emptySummary(sessionId: string, userId: string): SessionSummary {
    return {
      sessionId,
      userId,
      summary: '空会话',
      keywords: [],
      actionItems: [],
      preferences: [],
      messageCount: 0,
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
  }
}
