import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { Logger } from '../../shared/logging/logger';

export type LightLLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface LightLLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LightLLMContentPart[];
}

export interface LightLLMRequest {
  messages: LightLLMMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LightLLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
}

export interface LightLLMResponse {
  content: string;
  model: string;
  usage: LightLLMUsage;
}

export interface LightLLMStreamChunk {
  content: string;
  done?: boolean;
}

export interface LightLLMConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

function loadConfig(): LightLLMConfig {
  const apiKey = process.env.LIGHT_LLM_API_KEY ?? '';
  const baseUrl = process.env.LIGHT_LLM_BASE_URL ?? 'https://api.openai.com/v1';
  const defaultModel = process.env.LIGHT_LLM_MODEL ?? 'glm-4.5-air';

  return { apiKey, baseUrl, defaultModel };
}

export class LightLLMClient {
  private readonly logger = new Logger('LightLLMClient');
  private readonly config: LightLLMConfig;

  constructor(config?: Partial<LightLLMConfig>) {
    const envConfig = loadConfig();
    this.config = {
      apiKey: config?.apiKey ?? envConfig.apiKey,
      baseUrl: config?.baseUrl ?? envConfig.baseUrl,
      defaultModel: config?.defaultModel ?? envConfig.defaultModel,
    };
  }

  private ensureApiKey(): void {
    if (!this.config.apiKey) {
      throw new YourBotError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'LightLLM API key 未配置，请设置 LIGHT_LLM_API_KEY 环境变量',
      );
    }
  }

  async complete(request: LightLLMRequest): Promise<LightLLMResponse> {
    this.ensureApiKey();

    const model = request.model ?? this.config.defaultModel;
    const url = `${this.config.baseUrl}/chat/completions`;

    this.logger.debug('LightLLM complete 请求', { model, messageCount: request.messages.length });

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0.7,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new YourBotError(ERROR_CODES.LLM_API_ERROR, `LightLLM API 错误: ${response.status}`, {
          status: response.status,
          body: errorText,
        });
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: { content: string | null };
          finish_reason?: string;
        }>;
        model: string;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = data.choices?.[0]?.message?.content ?? '';
      const finishReason = data.choices?.[0]?.finish_reason;
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;

      if (!content && attempt < maxAttempts) {
        this.logger.warn('LightLLM 返回空内容，重试中', {
          attempt,
          finishReason,
          choicesLength: data.choices?.length ?? 0,
        });
        continue;
      }

      if (!content) {
        this.logger.warn('LightLLM 返回空内容', {
          finishReason,
          choicesLength: data.choices?.length ?? 0,
        });
      }

      return {
        content,
        model: data.model ?? model,
        usage: {
          promptTokens,
          completionTokens,
          totalCost: this.estimateCost(model, promptTokens, completionTokens),
        },
      };
    }

    /* istanbul ignore next -- unreachable but satisfies TS */
    return { content: '', model, usage: { promptTokens: 0, completionTokens: 0, totalCost: 0 } };
  }

  async *stream(request: LightLLMRequest): AsyncGenerator<LightLLMStreamChunk> {
    this.ensureApiKey();

    const model = request.model ?? this.config.defaultModel;
    const url = `${this.config.baseUrl}/chat/completions`;

    this.logger.debug('LightLLM stream 请求', { model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new YourBotError(
        ERROR_CODES.LLM_API_ERROR,
        `LightLLM stream API 错误: ${response.status}`,
        {
          status: response.status,
          body: errorText,
        },
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new YourBotError(ERROR_CODES.LLM_API_ERROR, 'LightLLM stream: 无法获取 reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              yield { content: delta };
            }
            if (parsed.choices?.[0]?.finish_reason) {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  getDefaultModel(): string {
    return this.config.defaultModel;
  }

  private estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    // Approximate costs per 1M tokens
    const costs: Record<string, { input: number; output: number }> = {
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'deepseek-chat': { input: 0.14, output: 0.28 },
      'qwen-turbo': { input: 0.1, output: 0.3 },
    };
    const rate = costs[model] ?? { input: 0.15, output: 0.6 };
    return (promptTokens * rate.input) / 1_000_000 + (completionTokens * rate.output) / 1_000_000;
  }
}
