import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import type { ContextSummary, WorkingMemoryConfig } from './memory-types';

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_COMPRESS_THRESHOLD = 0.8;

// Rough token estimation: ~4 chars per token for mixed CJK/English
const CHARS_PER_TOKEN = 4;

export class WorkingMemory {
  private readonly logger = new Logger('WorkingMemory');
  private readonly maxTokens: number;
  private readonly compressThreshold: number;
  private messages: ConversationMessage[] = [];
  private summaries: ContextSummary[] = [];

  constructor(config: Partial<WorkingMemoryConfig> = {}) {
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.compressThreshold = config.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD;
  }

  addMessage(message: ConversationMessage): void {
    this.messages.push(message);
    if (this.estimateTokens() > this.maxTokens * this.compressThreshold) {
      this.compress();
    }
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  getSummaries(): ContextSummary[] {
    return [...this.summaries];
  }

  getRecentMessages(count: number): ConversationMessage[] {
    return this.messages.slice(-count);
  }

  /**
   * Build the full context to send to the LLM:
   * [summaries as system context] + [recent messages]
   */
  buildContext(): { summaries: ContextSummary[]; messages: ConversationMessage[] } {
    return {
      summaries: [...this.summaries],
      messages: [...this.messages],
    };
  }

  estimateTokens(): number {
    let totalChars = 0;
    for (const s of this.summaries) {
      totalChars += s.content.length;
    }
    for (const m of this.messages) {
      totalChars += m.content.length + m.role.length + 4; // role + formatting overhead
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  getSummaryCount(): number {
    return this.summaries.length;
  }

  clear(): void {
    this.messages = [];
    this.summaries = [];
  }

  /**
   * Compress the older half of messages into a summary.
   * Uses extractive summarization (take key sentences) to avoid LLM dependency.
   */
  private compress(): void {
    const splitPoint = Math.floor(this.messages.length / 2);
    if (splitPoint === 0) return;

    const oldMessages = this.messages.splice(0, splitPoint);
    const summary = this.summarizeMessages(oldMessages);

    this.summaries.push({
      content: summary,
      messageCount: oldMessages.length,
      createdAt: Date.now(),
    });

    this.logger.info('上下文压缩', {
      compressedMessages: oldMessages.length,
      remainingMessages: this.messages.length,
      totalSummaries: this.summaries.length,
      estimatedTokens: this.estimateTokens(),
    });
  }

  /**
   * Extractive summary: take the first and last message content,
   * plus any messages mentioning key action words.
   */
  private summarizeMessages(messages: ConversationMessage[]): string {
    if (messages.length === 0) return '';
    if (messages.length <= 3) {
      return messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
    }

    const parts: string[] = [];

    // First message for context
    const first = messages[0]!;
    parts.push(`[${first.role}] ${first.content}`);

    // Pick key messages from the middle (containing action words or questions)
    const actionPatterns = /[?？]|帮|创建|修改|删除|请|需要|should|please|create|update|delete/i;
    const middleMessages = messages.slice(1, -1);
    const keyMessages = middleMessages.filter((m) => actionPatterns.test(m.content));

    // Take up to 3 key messages
    for (const m of keyMessages.slice(0, 3)) {
      parts.push(`[${m.role}] ${m.content}`);
    }

    // Last message for recency
    const last = messages[messages.length - 1]!;
    parts.push(`[${last.role}] ${last.content}`);

    return `[${messages.length}条消息摘要]\n${parts.join('\n')}`;
  }
}
