export interface AggregationResult {
  tasks: Array<{ message: string; original: string[] }>; // merged message + originals
  filtered: string[]; // noise messages that were dropped
  reason: string;
}

export class QueueAggregator {
  // biome-ignore lint/complexity/noUselessConstructor: explicit for bun coverage
  constructor() {}

  /**
   * Aggregate pending messages before executing next task.
   * @param messages - pending message contents in queue order
   * @param llmFallback - optional LLM for ambiguous cases
   */
  async aggregate(
    messages: string[],
    llmFallback?: (prompt: string) => Promise<string>,
  ): Promise<AggregationResult> {
    if (messages.length <= 1) {
      return {
        tasks: messages.map((m) => ({ message: m, original: [m] })),
        filtered: [],
        reason: 'single',
      };
    }

    // Step 1: Rule-based filtering
    const { meaningful, noise } = this.ruleFilter(messages);

    if (meaningful.length === 0) {
      return { tasks: [], filtered: noise, reason: 'all_noise' };
    }

    if (meaningful.length === 1) {
      const first = meaningful[0] as string;
      return {
        tasks: [{ message: first, original: [first] }],
        filtered: noise,
        reason: 'single_after_filter',
      };
    }

    // Step 2: Check for obvious override (last message supersedes)
    if (this.isOverride(meaningful)) {
      const last = meaningful[meaningful.length - 1] as string;
      return {
        tasks: [{ message: last, original: meaningful }],
        filtered: noise,
        reason: 'last_override',
      };
    }

    // Step 3: LLM fallback for ambiguous cases
    if (llmFallback && meaningful.length > 1) {
      try {
        const merged = await this.llmMerge(meaningful, llmFallback);
        return {
          tasks: [{ message: merged, original: meaningful }],
          filtered: noise,
          reason: 'llm_merged',
        };
      } catch {
        // LLM failed, keep all as independent tasks
      }
    }

    // Fallback: keep all as independent tasks
    return {
      tasks: meaningful.map((m) => ({ message: m, original: [m] })),
      filtered: noise,
      reason: 'independent',
    };
  }

  private ruleFilter(messages: string[]): { meaningful: string[]; noise: string[] } {
    const noise: string[] = [];
    const meaningful: string[] = [];

    for (const msg of messages) {
      if (this.isNoise(msg)) {
        noise.push(msg);
      } else {
        meaningful.push(msg);
      }
    }

    return { meaningful, noise };
  }

  private isNoise(msg: string): boolean {
    const trimmed = msg.trim();
    // Pure numbers/symbols/emoji
    if (/^[\d\s\p{Emoji}\p{Symbol}\p{Punctuation}]+$/u.test(trimmed)) return true;
    // Greetings/confirmations (short)
    if (trimmed.length <= 4 && /^(在吗|你好|嗯|ok|好的|hi|hey|哦|啊|呢)$/i.test(trimmed)) {
      return true;
    }
    return false;
  }

  private isOverride(messages: string[]): boolean {
    // If last message starts with correction/override patterns
    const last = messages[messages.length - 1] as string;
    return /^(不是|不对|错了|我是说|我的意思是|算了|换成)/i.test(last.trim());
  }

  private async llmMerge(
    messages: string[],
    llm: (prompt: string) => Promise<string>,
  ): Promise<string> {
    const prompt = `用户在等待回复时连续发了以下消息：
${messages.map((m, i) => `${i + 1}. "${m}"`).join('\n')}

请判断用户的真实意图，合并为一条完整的请求。只返回合并后的消息内容，不要解释。`;

    return llm(prompt);
  }
}
