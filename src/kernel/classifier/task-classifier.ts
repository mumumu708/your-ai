import { Logger } from '../../shared/logging/logger';
import type { LightLLMClient } from '../agents/light-llm-client';
import type {
  ClassifierStats,
  ClassifyContext,
  TaskComplexity,
  UnifiedClassifyResult,
} from './classifier-types';

// Explicit harness triggers only — fuzzy patterns removed (LLM handles those)
const HARNESS_PATTERNS: RegExp[] = [/^\/harness\b/i, /^harness:/i];

const SYSTEM_COMMAND_PREFIX = '/';

const SCHEDULE_PATTERNS: RegExp[] = [
  /每[天日周月]/,
  /定时/,
  /提醒我/,
  /remind/i,
  /schedule/i,
  /every\s+(day|week|month|hour|minute)/i,
  /at\s+\d{1,2}:\d{2}/i,
  /cron/i,
];

const AUTOMATION_PATTERNS: RegExp[] = [/自动化/, /批量/, /automate/i, /batch/i, /workflow/i];

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

  async classify(message: string, context: ClassifyContext = {}): Promise<UnifiedClassifyResult> {
    this.stats.total++;

    // 上下文信号：最近用过工具 → chat + complex
    if (context.hasRecentToolUse) {
      this.stats.ruleClassified++;
      this.stats.complexCount++;
      return {
        taskType: 'chat',
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

    this.logger.info('统一分类结果', {
      taskType: llmResult.taskType,
      complexity: llmResult.complexity,
      reason: llmResult.reason,
      classifiedBy: llmResult.classifiedBy,
      costUsd: llmResult.costUsd,
    });

    return llmResult;
  }

  ruleClassify(message: string): UnifiedClassifyResult | null {
    const trimmed = message.trim();

    // 1. Explicit harness triggers
    for (const pattern of HARNESS_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          taskType: 'harness',
          complexity: 'complex',
          reason: `规则命中: ${pattern.source}`,
          confidence: 0.95,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      }
    }

    // 2. System commands (slash commands except /harness)
    if (trimmed.startsWith(SYSTEM_COMMAND_PREFIX)) {
      return {
        taskType: 'system',
        complexity: 'complex',
        reason: '规则命中: 斜杠命令',
        confidence: 0.95,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // 3. Schedule patterns
    for (const pattern of SCHEDULE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          taskType: 'scheduled',
          complexity: 'complex',
          reason: `规则命中: ${pattern.source}`,
          confidence: 0.9,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      }
    }

    // 4. Automation patterns
    for (const pattern of AUTOMATION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          taskType: 'automation',
          complexity: 'complex',
          reason: `规则命中: ${pattern.source}`,
          confidence: 0.9,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      }
    }

    // 5. Simple patterns → chat + simple
    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          taskType: 'chat',
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

  private async llmClassify(message: string): Promise<UnifiedClassifyResult> {
    if (!this.lightLLM) {
      this.logger.warn('LightLLM 未配置，默认分类为 chat + complex');
      return {
        taskType: 'chat',
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
              '你是一个任务分类器。根据用户消息判断两个维度：\n1. taskType: "chat"(对话/问答) | "harness"(工程开发任务:改代码/修bug/跑测试/部署/重构等) | "scheduled"(定时提醒) | "automation"(批量自动化) | "system"(系统命令)\n2. complexity: "simple"(简单问答/闲聊) | "complex"(需要工具/代码/多步推理)\n只回复 JSON: {"taskType":"...","complexity":"...","reason":"..."}',
          },
          { role: 'user', content: message },
        ],
        maxTokens: 100,
        temperature: 0,
      });

      const parsed = this.extractJson(response.content);
      if (!parsed) {
        this.logger.warn('LLM 返回内容无法解析为 JSON', {
          content: response.content.slice(0, 200),
        });
        return {
          taskType: 'chat',
          complexity: 'complex',
          reason: 'LLM 返回格式异常，保守默认',
          confidence: 0.5,
          classifiedBy: 'llm',
          costUsd: response.usage?.totalCost ?? 0,
        };
      }

      const taskType = this.normalizeTaskType(parsed.taskType);
      const complexity: TaskComplexity = parsed.complexity === 'simple' ? 'simple' : 'complex';

      return {
        taskType,
        complexity,
        reason: parsed.reason || 'LLM 分类',
        confidence: 0.75,
        classifiedBy: 'llm',
        costUsd: response.usage?.totalCost ?? 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM 分类失败，保守默认为 chat + complex', { error: errorMsg });
      return {
        taskType: 'chat',
        complexity: 'complex',
        reason: `LLM 分类失败: ${errorMsg}`,
        confidence: 0.5,
        classifiedBy: 'llm',
        costUsd: 0,
      };
    }
  }

  /**
   * Normalize LLM-returned taskType to valid TaskType.
   * Falls back to 'chat' for unknown values.
   */
  private normalizeTaskType(
    raw?: string,
  ): 'chat' | 'scheduled' | 'automation' | 'system' | 'harness' {
    const valid = ['chat', 'scheduled', 'automation', 'system', 'harness'] as const;
    if (raw && valid.includes(raw as (typeof valid)[number])) {
      return raw as (typeof valid)[number];
    }
    return 'chat';
  }

  /**
   * 从 LLM 响应中提取 JSON，处理 markdown 代码块包裹的情况。
   * 支持: 纯 JSON / ```json ... ``` / ``` ... ```
   */
  private extractJson(
    content: string,
  ): { taskType?: string; complexity: string; reason?: string } | null {
    const trimmed = content.trim();

    // 1. 尝试直接解析
    try {
      return JSON.parse(trimmed);
    } catch {
      // continue
    }

    // 2. 提取 markdown 代码块内容
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1]!.trim());
      } catch {
        // continue
      }
    }

    // 3. 提取第一个 JSON 对象
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // give up
      }
    }

    return null;
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
