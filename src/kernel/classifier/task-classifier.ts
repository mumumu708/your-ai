import { Logger } from '../../shared/logging/logger';
import type { LightLLMClient } from '../agents/light-llm-client';
import type {
  ClassifierStats,
  ClassifyContext,
  ClassifyResult,
  TaskComplexity,
} from './classifier-types';

const COMPLEX_PATTERNS: RegExp[] = [
  /^\/\w+/, // 斜杠命令
  /帮我(写|创建|修改|生成|开发|实现|部署|搭建)/,
  /帮忙(写|创建|修改|生成|开发|实现)/,
  /(请|麻烦).{0,4}(写|创建|修改|生成|开发)/,
  /\b(git|npm|docker|kubectl|yarn|pnpm|bun)\s/i,
  /(debug|调试|排查|定位问题|报错|异常)/i,
  /(重构|优化|迁移|升级|部署)/,
  /(write|create|build|implement|develop|deploy|refactor)\s/i,
  /(分析|解释).{0,10}(代码|源码|日志|错误)/,
  /\b(fix|resolve|patch)\s/i,
];

const SIMPLE_PATTERNS: RegExp[] = [
  /^.{1,10}$/, // 超短消息（10字符以内）
  /^(你好|hi|hello|hey|嗨|哈喽)\s*[!！.。]?$/i, // 纯问候
  /^[^写创建修改帮]*\?$/, // 纯提问（?结尾且无动作词）
  /(翻译|translate).{0,5}(:|：)/i, // 翻译请求
  /^(谢谢|thanks|thank you|ok|好的|收到|明白)/i, // 简单回复
  /^(什么是|whats?|who is|how old|几岁|多大)/i, // 简单问答
];

export class TaskClassifier {
  private readonly logger = new Logger('TaskClassifier');
  private lightLLM: LightLLMClient | null;
  private stats: ClassifierStats = {
    total: 0,
    ruleClassified: 0,
    llmClassified: 0,
    simpleCount: 0,
    complexCount: 0,
  };

  constructor(lightLLM: LightLLMClient | null = null) {
    this.lightLLM = lightLLM;
  }

  async classify(message: string, context: ClassifyContext = {}): Promise<ClassifyResult> {
    this.stats.total++;

    // 上下文信号：最近用过工具 → complex
    if (context.hasRecentToolUse) {
      this.stats.ruleClassified++;
      this.stats.complexCount++;
      return {
        complexity: 'complex',
        reason: '上下文信号：最近使用过工具',
        confidence: 0.8,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // 第一层：规则分类
    const ruleResult = this.ruleClassify(message);
    if (ruleResult) {
      this.stats.ruleClassified++;
      if (ruleResult.complexity === 'simple') {
        this.stats.simpleCount++;
      } else {
        this.stats.complexCount++;
      }
      return ruleResult;
    }

    // 第二层：LLM 分类（模糊地带兜底）
    const llmResult = await this.llmClassify(message);
    this.stats.llmClassified++;
    if (llmResult.complexity === 'simple') {
      this.stats.simpleCount++;
    } else {
      this.stats.complexCount++;
    }
    return llmResult;
  }

  ruleClassify(message: string): ClassifyResult | null {
    const trimmed = message.trim();

    for (const pattern of COMPLEX_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          complexity: 'complex',
          reason: `规则命中: ${pattern.source}`,
          confidence: 0.9,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      }
    }

    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          complexity: 'simple',
          reason: `规则命中: ${pattern.source}`,
          confidence: 0.85,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      }
    }

    return null;
  }

  private async llmClassify(message: string): Promise<ClassifyResult> {
    if (!this.lightLLM) {
      this.logger.warn('LightLLM 未配置，默认分类为 complex');
      return {
        complexity: 'complex',
        reason: 'LightLLM 未配置，保守默认',
        confidence: 0.5,
        classifiedBy: 'llm',
        costUsd: 0,
      };
    }

    try {
      const response = await this.lightLLM.complete({
        messages: [
          {
            role: 'system',
            content:
              '你是一个任务分类器。判断用户消息是"simple"（简单问答/闲聊）还是"complex"（需要工具/代码/多步骤推理）。只回复 JSON: {"complexity":"simple"或"complex","reason":"原因"}',
          },
          { role: 'user', content: message },
        ],
        maxTokens: 100,
        temperature: 0,
      });

      const parsed = JSON.parse(response.content);
      const complexity: TaskComplexity = parsed.complexity === 'simple' ? 'simple' : 'complex';

      return {
        complexity,
        reason: parsed.reason || 'LLM 分类',
        confidence: 0.75,
        classifiedBy: 'llm',
        costUsd: response.usage?.totalCost ?? 0,
      };
    } catch (error) {
      this.logger.warn('LLM 分类失败，保守默认为 complex', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        complexity: 'complex',
        reason: 'LLM 分类失败，保守默认',
        confidence: 0.5,
        classifiedBy: 'llm',
        costUsd: 0,
      };
    }
  }

  getStats(): ClassifierStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      total: 0,
      ruleClassified: 0,
      llmClassified: 0,
      simpleCount: 0,
      complexCount: 0,
    };
  }
}
