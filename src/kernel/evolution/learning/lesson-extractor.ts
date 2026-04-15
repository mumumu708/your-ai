import type { ErrorSignal } from './error-detector';

export interface ExtractedLesson {
  action: string;
  category: 'preference' | 'fact' | 'instruction';
  lesson: string;
  mergeTarget?: string; // existing lesson to merge with
}

export type LlmCallFn = (prompt: string) => Promise<string>;

/**
 * Extracts a structured lesson from an error signal using LLM.
 * Falls back to rule-based extraction if LLM is unavailable.
 */
export async function extractLesson(
  signal: ErrorSignal,
  llmCall?: LlmCallFn | null,
): Promise<ExtractedLesson> {
  // Try LLM extraction for richer lessons
  if (llmCall) {
    try {
      const prompt = `从用户的纠正中提取经验教训。
用户说："${signal.text}"
信号类型：${signal.type}

请输出 JSON 格式：
{"action": "简述应该怎么做", "category": "${signal.category}", "lesson": "一句话总结教训"}

只输出 JSON，不要其他内容。`;

      const result = await llmCall(prompt);
      const parsed = JSON.parse(result.trim()) as {
        action?: string;
        category?: string;
        lesson?: string;
      };

      if (parsed.action && parsed.lesson) {
        return {
          action: parsed.action,
          category: (parsed.category as ExtractedLesson['category']) ?? signal.category,
          lesson: parsed.lesson,
        };
      }
    } catch {
      // Fall through to rule-based
    }
  }

  // Rule-based fallback
  return {
    action: signal.text.slice(0, 60),
    category: signal.category,
    lesson: buildRuleLesson(signal),
  };
}

function buildRuleLesson(signal: ErrorSignal): string {
  switch (signal.type) {
    case 'correction':
      return `用户纠正：${signal.text}`;
    case 'repetition':
      return '用户多次请求未得到满意回应，需改进处理方式';
    case 'frustration':
      return '用户表达不满，需改进交互体验';
  }
}
