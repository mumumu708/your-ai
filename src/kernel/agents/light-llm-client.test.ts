import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { LightLLMClient } from './light-llm-client';

const originalFetch = globalThis.fetch;

function mockFetch(responseBody: unknown, status = 200): void {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
    body: null,
  })) as unknown as typeof fetch;
}

function mockStreamFetch(chunks: string[]): void {
  globalThis.fetch = (async () => {
    const sseData = chunks
      .map((c) =>
        c === '[DONE]'
          ? 'data: [DONE]\n\n'
          : `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`,
      )
      .join('');

    const encoder = new TextEncoder();
    const data = encoder.encode(sseData);

    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let read = false;
          return {
            read: async () => {
              if (!read) {
                read = true;
                return { done: false, value: data };
              }
              return { done: true, value: undefined };
            },
            releaseLock: () => {},
          };
        },
      },
    };
  }) as unknown as typeof fetch;
}

describe('LightLLMClient', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('complete', () => {
    test('应该发送请求并返回解析后的响应', async () => {
      mockFetch({
        choices: [{ message: { content: 'Hello!' } }],
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.content).toBe('Hello!');
      expect(result.model).toBe('gpt-4o-mini');
      expect(result.usage.promptTokens).toBe(10);
      expect(result.usage.completionTokens).toBe(5);
    });

    test('应该在 API 错误时抛出 YourBotError', async () => {
      mockFetch({ error: 'rate limit' }, 429);

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        await client.complete({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).code).toBe('LLM_API_ERROR');
      }
    });

    test('应该在未配置 API key 时抛出 YourBotError', async () => {
      const client = new LightLLMClient({
        apiKey: '',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        await client.complete({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).code).toBe('SERVICE_UNAVAILABLE');
      }
    });
  });

  describe('stream', () => {
    test('应该返回流式响应块', async () => {
      mockStreamFetch(['Hello', ' World', '[DONE]']);

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      const chunks: string[] = [];
      for await (const chunk of client.stream({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.content) {
          chunks.push(chunk.content);
        }
      }

      expect(chunks).toEqual(['Hello', ' World']);
    });

    test('应该在 API 错误时抛出 YourBotError', async () => {
      mockFetch({ error: 'error' }, 500);

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        const gen = client.stream({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        await gen.next();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
      }
    });
  });

  describe('stream (additional)', () => {
    test('应该处理 finish_reason 结束', async () => {
      const sseData = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      ].join('');

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let read = false;
            return {
              read: async () => {
                if (!read) {
                  read = true;
                  return { done: false, value: new TextEncoder().encode(sseData) };
                }
                return { done: true, value: undefined };
              },
              releaseLock: () => {},
            };
          },
        },
      })) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      const chunks: string[] = [];
      for await (const chunk of client.stream({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.content) chunks.push(chunk.content);
        if (chunk.done) break;
      }

      expect(chunks).toEqual(['hi']);
    });

    test('应该在无 body reader 时抛出 YourBotError', async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        body: null,
      })) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        const gen = client.stream({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        await gen.next();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
      }
    });

    test('应该在未配置 API key 时抛出 YourBotError', async () => {
      const client = new LightLLMClient({
        apiKey: '',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        const gen = client.stream({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        await gen.next();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).code).toBe('SERVICE_UNAVAILABLE');
      }
    });

    test('应该跳过格式错误的 SSE 行', async () => {
      const sseData = [
        'data: not-json\n\n',
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let read = false;
            return {
              read: async () => {
                if (!read) {
                  read = true;
                  return { done: false, value: new TextEncoder().encode(sseData) };
                }
                return { done: true, value: undefined };
              },
              releaseLock: () => {},
            };
          },
        },
      })) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      const chunks: string[] = [];
      for await (const chunk of client.stream({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.content) chunks.push(chunk.content);
      }

      expect(chunks).toEqual(['ok']);
    });
  });

  describe('complete (additional)', () => {
    test('应该在首次返回空内容时重试一次', async () => {
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        const content = callCount === 1 ? '' : 'retry ok';
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            choices: [{ message: { content }, finish_reason: 'stop' }],
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          body: null,
        };
      }) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(callCount).toBe(2);
      expect(result.content).toBe('retry ok');
    });

    test('应该在重试后仍为空内容时返回空字符串', async () => {
      mockFetch({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.content).toBe('');
    });

    test('应该在 choices 为空数组时重试', async () => {
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        const choices =
          callCount === 1 ? [] : [{ message: { content: 'ok' }, finish_reason: 'stop' }];
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            choices,
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          body: null,
        };
      }) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(callCount).toBe(2);
      expect(result.content).toBe('ok');
    });

    test('应该使用未知模型的默认费率估算成本', async () => {
      mockFetch({
        choices: [{ message: { content: 'ok' } }],
        model: 'unknown-model',
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'unknown-model',
      });

      expect(result.usage.totalCost).toBeGreaterThan(0);
    });

    test('应该处理缺少 usage 字段的响应', async () => {
      mockFetch({
        choices: [{ message: { content: 'ok' } }],
        model: 'gpt-4o-mini',
      });

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(0);
    });
  });

  describe('error body fallback', () => {
    test('complete: response.text() 抛出时使用 "unknown" 作为 error body', async () => {
      globalThis.fetch = (async () => ({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error('text() failed');
        },
        json: async () => ({}),
        body: null,
      })) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        await client.complete({ messages: [{ role: 'user', content: 'Hi' }] });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).context).toMatchObject({ body: 'unknown' });
      }
    });

    test('stream: response.text() 抛出时使用 "unknown" 作为 error body', async () => {
      globalThis.fetch = (async () => ({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error('text() failed');
        },
        json: async () => ({}),
        body: null,
      })) as unknown as typeof fetch;

      const client = new LightLLMClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
      });

      try {
        const gen = client.stream({ messages: [{ role: 'user', content: 'Hi' }] });
        await gen.next();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(YourBotError);
        expect((error as YourBotError).context).toMatchObject({ body: 'unknown' });
      }
    });
  });

  describe('getDefaultModel', () => {
    test('应该返回配置的默认模型', () => {
      const client = new LightLLMClient({
        apiKey: 'test-key',
        defaultModel: 'deepseek-chat',
      });
      expect(client.getDefaultModel()).toBe('deepseek-chat');
    });

    test('应该在未传 model 参数时从环境变量读取默认值', () => {
      const client = new LightLLMClient({ apiKey: 'test-key' });
      // Falls back to LIGHT_LLM_MODEL env var, or 'glm-4.5-air' if unset
      const expected = process.env.LIGHT_LLM_MODEL ?? 'glm-4.5-air';
      expect(client.getDefaultModel()).toBe(expected);
    });
  });
});
