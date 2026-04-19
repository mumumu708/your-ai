import { Logger } from '../../shared/logging/logger';
import type { AgentBridge, AgentExecuteParams, AgentResult } from './agent-bridge';

/** LightLLM 的最小接口 — 只依赖 complete 能力 */
export interface LightLlmCompletable {
  complete(params: {
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ content: string; usage?: { promptTokens?: number; completionTokens?: number } }>;
}

/** Gateway 层的入口参数 */
export interface GatewayHandleParams {
  /** 用户原始消息 */
  message: string;
  /** 任务复杂度 */
  complexity: 'simple' | 'complex';
  /** 任务类型 */
  taskType: string;
  /** 是否包含附件 */
  hasAttachments: boolean;
  /** 传递给 AgentBridge 的完整参数（复杂任务必填） */
  agentParams?: AgentExecuteParams;
}

/** Gateway 快速应答的精简 prompt */
const QUICK_ANSWER_PROMPT = `你是 YourBot，一个个人 AI 助手。
简洁直接地回答用户问题。自动检测并使用用户的语言。
如果问题需要查询记忆、使用工具或深入分析，回复"我需要更仔细地处理这个问题"。`;

/**
 * IntelligenceGateway — Layer 1: 快速预处理层。
 *
 * 职责：
 * 1. 拦截不需要 agency 的简单任务，用 LightLLM 快速回答
 * 2. 需要 agency 的任务透传给 AgentBridge（Layer 2）
 * 3. 安全阀：LightLLM 自认为答不好时自动降级到 Agent Layer
 */
export class IntelligenceGateway {
  private readonly logger = new Logger('IntelligenceGateway');

  constructor(
    private readonly lightLlm: LightLlmCompletable,
    private readonly agentBridge: AgentBridge,
  ) {}

  async handle(params: GatewayHandleParams): Promise<AgentResult> {
    if (this.canHandleDirectly(params)) {
      this.logger.info('Gateway 直接处理', { taskType: params.taskType });
      return this.quickAnswer(params);
    }

    this.logger.info('下沉到 Agent Layer', {
      taskType: params.taskType,
      complexity: params.complexity,
    });
    if (!params.agentParams) {
      throw new Error('agentParams required for non-gateway tasks');
    }
    return this.agentBridge.execute(params.agentParams);
  }

  /**
   * 严格条件：只拦截明确不需要 agency 的任务。
   * 宁可多下沉，不可错拦截。
   */
  canHandleDirectly(params: GatewayHandleParams): boolean {
    return (
      params.complexity === 'simple' &&
      params.taskType === 'chat' &&
      !params.hasAttachments &&
      !this.mightNeedTools(params.message) &&
      !this.mightNeedMemory(params.message)
    );
  }

  /** 启发式检测：消息是否可能需要工具 */
  mightNeedTools(content: string): boolean {
    const toolIndicators = [
      /文件|文档|代码|搜索|查[找询]|计算|分析|创建|修改|删除|图片|截图|照片/,
      /file|code|search|create|modify|delete|calculate|analyze/i,
      /帮我|请你|能不能|可以.*吗/,
    ];
    return toolIndicators.some((r) => r.test(content));
  }

  /** 启发式检测：消息是否可能需要记忆检索 */
  mightNeedMemory(content: string): boolean {
    const memoryIndicators = [
      // Explicit memory references
      /之前|上次|上周|昨天|记得|提到过|讨论过|我说过/,
      /previously|last time|remember|mentioned|discussed/i,
      // Personal questions that need user memory
      /我的|我[在从去做了有没]|我[是叫住]|[你我].*[几什哪][么个时]|[你我].*过[几什哪]|参加过/,
      // Questions about specific people/events (likely need stored memories)
      /[月份日].*[做了去过参]|天气.*取消|具体|哪[些项个几次位]/,
      // Temporal references indicating historical recall
      /[0-9]{4}年|[0-9]{1,2}月|月份|春节|元旦|周[一二三四五六日末]/,
    ];
    return memoryIndicators.some((r) => r.test(content));
  }

  /** 安全阀：LightLLM 回复表明无法处理 */
  private isSafetyValveTrigger(content?: string): boolean {
    if (!content) return false;
    return /我需要更仔细地处理这个问题|I need to (?:handle|process|think about) this more carefully/i.test(
      content,
    );
  }

  private async quickAnswer(params: GatewayHandleParams): Promise<AgentResult> {
    const response = await this.lightLlm.complete({
      messages: [
        { role: 'system', content: QUICK_ANSWER_PROMPT },
        { role: 'user', content: params.message },
      ],
    });

    // 安全阀：LightLLM 自认为答不好，升级到 Agent Layer
    if (this.isSafetyValveTrigger(response.content) && params.agentParams) {
      this.logger.info('LightLLM回答不好，升级到 Agent Layer');
      return this.agentBridge.execute(params.agentParams);
    }

    return {
      content: response.content || '',
      tokenUsage: {
        inputTokens: response.usage?.promptTokens ?? 0,
        outputTokens: response.usage?.completionTokens ?? 0,
      },
      finishedNaturally: true,
      handledBy: 'gateway',
    };
  }
}
