import { existsSync, readFileSync } from 'node:fs';
import type {
  AgentExecuteParams,
  AgentResult,
  ConversationMessage,
} from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import type { MediaRef } from '../../shared/messaging/media-attachment.types';
import type { ClassifyContext } from '../classifier/classifier-types';
import type { TaskClassifier } from '../classifier/task-classifier';
import type { AgentBridge } from './agent-bridge';
import type { LightLLMClient, LightLLMContentPart, LightLLMMessage } from './light-llm-client';

export interface AgentRuntimeDeps {
  classifier?: TaskClassifier | null;
  agentBridge?: AgentBridge | null;
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
  private readonly agentBridge: AgentBridge | null;
  private readonly lightLLM: LightLLMClient | null;

  constructor(deps: AgentRuntimeDeps = {}) {
    this.classifier = deps.classifier ?? null;
    this.agentBridge = deps.agentBridge ?? null;
    this.lightLLM = deps.lightLLM ?? null;
  }

  async execute(params: AgentExecuteParams): Promise<EnhancedAgentResult> {
    this.logger.info('Agent 执行请求', {
      agentId: params.agentId,
      sessionId: params.context.sessionId,
    });

    // Harness tasks must always use Claude (tool access required)
    if (params.forceComplex) {
      return this.executeComplex(params);
    }

    // Use pre-computed classification result if available
    if (params.classifyResult) {
      this.logger.info('分类结果', {
        sessionId: params.context.sessionId,
        complexity: params.classifyResult.complexity,
        taskType: params.classifyResult.taskType,
        reason: params.classifyResult.reason,
        classifiedBy: params.classifyResult.classifiedBy,
      });
      if (params.classifyResult.complexity === 'simple') {
        try {
          return await this.executeSimple(params, params.classifyResult.costUsd);
        } catch (error) {
          this.logger.warn('LightLLM 失败，降级到 Claude', {
            error: error instanceof Error ? error.message : String(error),
          });
          return this.executeComplex(params, params.classifyResult.costUsd);
        }
      }
      return this.executeComplex(params, params.classifyResult.costUsd);
    }

    // Fallback: no pre-computed result — run classifier inline (backward compat)
    if (!this.classifier) {
      return this.executeComplex(params);
    }

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
      taskType: classification.taskType,
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
    if (!this.agentBridge) {
      this.logger.warn('AgentBridge 未配置，返回占位结果');
      return {
        content: '[AgentRuntime] Agent Bridge 未配置。',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        complexity: 'complex',
        channel: 'agent_sdk',
        classificationCostUsd,
      };
    }

    const lastMsg = this.getLastUserMessage(params) ?? '';
    // Extract mediaRefs from the last user message
    const lastUserMsg = this.getLastUserConversationMessage(params);
    const result = await this.agentBridge.execute({
      systemPrompt: params.context.systemPrompt ?? '',
      prependContext: '',
      userMessage: lastMsg,
      sessionId: params.context.sessionId,
      claudeSessionId: params.context.claudeSessionId,
      workspacePath: params.context.workspacePath,
      signal: params.signal,
      streamCallback: params.streamCallback
        ? async (event) => params.streamCallback!(event)
        : undefined,
      executionMode: 'sync',
      mediaRefs: lastUserMsg?.mediaRefs,
    });

    return {
      content: result.content,
      tokenUsage: result.tokenUsage,
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
      // Build multimodal content if the message has media (base64 in memory or on disk)
      if (m.role === 'user' && m.mediaRefs?.some((r) => r.base64Data || r.localPath)) {
        const parts: LightLLMContentPart[] = [];
        if (m.content) {
          parts.push({ type: 'text', text: m.content });
        }
        for (const ref of m.mediaRefs ?? []) {
          const base64 = this.resolveMediaBase64(ref);
          if (base64 && ref.mimeType) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${ref.mimeType};base64,${base64}` },
            });
          }
        }
        messages.push({ role: 'user', content: parts.length > 0 ? parts : m.content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
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
    return this.getLastUserConversationMessage(params)?.content ?? null;
  }

  private getLastUserConversationMessage(params: AgentExecuteParams): ConversationMessage | null {
    const msgs = params.context.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg?.role === 'user') {
        return msg;
      }
    }
    return null;
  }

  /** Resolve base64 data from memory or disk */
  private resolveMediaBase64(ref: MediaRef): string | undefined {
    if (ref.base64Data) return ref.base64Data;
    if (ref.localPath && existsSync(ref.localPath)) {
      try {
        return readFileSync(ref.localPath).toString('base64');
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
