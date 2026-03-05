import type { AgentExecuteParams, AgentResult } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import type { ClassifyContext } from '../classifier/classifier-types';
import type { TaskClassifier } from '../classifier/task-classifier';
import type { ClaudeAgentBridge } from './claude-agent-bridge';
import type { LightLLMClient, LightLLMMessage } from './light-llm-client';

export interface AgentRuntimeDeps {
  classifier?: TaskClassifier | null;
  claudeBridge?: ClaudeAgentBridge | null;
  lightLLM?: LightLLMClient | null;
}

export interface EnhancedAgentResult extends AgentResult {
  complexity: 'simple' | 'complex';
  channel: 'agent_sdk' | 'light_llm';
  classificationCostUsd: number;
}

export class AgentRuntime {
  private readonly logger = new Logger('AgentRuntime');
  private readonly classifier: TaskClassifier | null;
  private readonly claudeBridge: ClaudeAgentBridge | null;
  private readonly lightLLM: LightLLMClient | null;

  constructor(deps: AgentRuntimeDeps = {}) {
    this.classifier = deps.classifier ?? null;
    this.claudeBridge = deps.claudeBridge ?? null;
    this.lightLLM = deps.lightLLM ?? null;
  }

  async execute(params: AgentExecuteParams): Promise<EnhancedAgentResult> {
    this.logger.info('Agent 执行请求', {
      agentId: params.agentId,
      sessionId: params.context.sessionId,
    });

    // If no classifier, default to complex path
    if (!this.classifier) {
      return this.executeComplex(params);
    }

    // Build classification context
    const lastUserMessage = this.getLastUserMessage(params);
    if (!lastUserMessage) {
      return this.executeComplex(params);
    }

    const classifyContext: ClassifyContext = {
      conversationLength: params.context.messages.length,
    };

    const classification = await this.classifier.classify(lastUserMessage, classifyContext);

    this.logger.info('分类结果', {
      sessionId: params.context.sessionId,
      complexity: classification.complexity,
      reason: classification.reason,
      classifiedBy: classification.classifiedBy,
    });

    if (classification.complexity === 'simple') {
      return this.executeSimple(params, classification.costUsd);
    }
    return this.executeComplex(params, classification.costUsd);
  }

  private async executeComplex(
    params: AgentExecuteParams,
    classificationCostUsd = 0,
  ): Promise<EnhancedAgentResult> {
    if (!this.claudeBridge) {
      this.logger.warn('ClaudeAgentBridge 未配置，返回占位结果');
      return {
        content: '[AgentRuntime] Claude Agent Bridge 未配置。',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd,
      };
    }

    const result = await this.claudeBridge.execute({
      sessionId: params.context.sessionId,
      messages: params.context.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      systemPrompt: params.context.systemPrompt,
      signal: params.signal,
      onStream: params.streamCallback,
      cwd: params.context.workspacePath,
      claudeSessionId: params.context.claudeSessionId,
    });

    return {
      content: result.content,
      tokenUsage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      toolsUsed: result.toolsUsed,
      claudeSessionId: result.claudeSessionId,
      complexity: 'complex',
      channel: 'agent_sdk',
      classificationCostUsd,
    };
  }

  private async executeSimple(
    params: AgentExecuteParams,
    classificationCostUsd = 0,
  ): Promise<EnhancedAgentResult> {
    if (!this.lightLLM) {
      this.logger.warn('LightLLMClient 未配置，回退到 complex 通道');
      return this.executeComplex(params, classificationCostUsd);
    }

    const messages: LightLLMMessage[] = [];

    if (params.context.systemPrompt) {
      messages.push({ role: 'system', content: params.context.systemPrompt });
    }

    for (const m of params.context.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    if (params.streamCallback) {
      // Stream mode
      let content = '';
      try {
        for await (const chunk of this.lightLLM.stream({ messages })) {
          if (params.signal?.aborted) break;
          if (chunk.content) {
            content += chunk.content;
            params.streamCallback({
              type: 'text_delta',
              text: chunk.content,
            });
          }
        }
        params.streamCallback({ type: 'done' });
      } catch (error) {
        params.streamCallback({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      return {
        content,
        tokenUsage: { inputTokens: 0, outputTokens: 0 }, // Stream doesn't return usage
        complexity: 'simple',
        channel: 'light_llm',
        classificationCostUsd,
      };
    }

    // Non-stream mode
    const response = await this.lightLLM.complete({ messages });

    return {
      content: response.content,
      tokenUsage: {
        inputTokens: response.usage.promptTokens,
        outputTokens: response.usage.completionTokens,
      },
      complexity: 'simple',
      channel: 'light_llm',
      classificationCostUsd,
    };
  }

  private getLastUserMessage(params: AgentExecuteParams): string | null {
    const msgs = params.context.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg?.role === 'user') {
        return msg.content;
      }
    }
    return null;
  }
}
