import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { LightLLMClient } from '../agents/light-llm-client';
import { TaskClassifier } from './task-classifier';

function createMockLightLLM(overrides: Partial<LightLLMClient> = {}): LightLLMClient {
  return {
    complete: async () => ({
      content: '{"complexity":"simple","reason":"test"}',
      usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
    }),
    stream: async function* () {
      yield { content: 'test' };
    },
    getDefaultModel: () => 'gpt-4o-mini',
    ...overrides,
  } as unknown as LightLLMClient;
}

describe('TaskClassifier', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('规则分类 - complex 模式', () => {
    test('应该将斜杠命令分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('/deploy production');
      expect(result.complexity).toBe('complex');
      expect(result.classifiedBy).toBe('rule');
      expect(result.costUsd).toBe(0);
    });

    test('应该将"帮我写"分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('帮我写一个排序算法');
      expect(result.complexity).toBe('complex');
      expect(result.classifiedBy).toBe('rule');
    });

    test('应该将"帮我创建"分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('帮我创建一个新项目');
      expect(result.complexity).toBe('complex');
    });

    test('应该将 git 命令分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('git push origin main');
      expect(result.complexity).toBe('complex');
    });

    test('应该将 npm 命令分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('npm install express');
      expect(result.complexity).toBe('complex');
    });

    test('应该将 docker 命令分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('docker build -t myapp .');
      expect(result.complexity).toBe('complex');
    });

    test('应该将 debug 请求分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('debug 一下这个函数');
      expect(result.complexity).toBe('complex');
    });

    test('应该将英文 write 请求分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('write a function that sorts arrays');
      expect(result.complexity).toBe('complex');
    });

    test('应该将"重构"分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('重构这段代码');
      expect(result.complexity).toBe('complex');
    });

    test('应该将 fix 请求分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('fix the login bug');
      expect(result.complexity).toBe('complex');
    });
  });

  describe('规则分类 - simple 模式', () => {
    test('应该将超短消息分类为 simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('你好');
      expect(result.complexity).toBe('simple');
      expect(result.classifiedBy).toBe('rule');
    });

    test('应该将纯问候分类为 simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('hello!');
      expect(result.complexity).toBe('simple');
    });

    test('应该将翻译请求分类为 simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('翻译: Hello World');
      expect(result.complexity).toBe('simple');
    });

    test('应该将简单回复分类为 simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('谢谢');
      expect(result.complexity).toBe('simple');
    });

    test('应该将 thanks 分类为 simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('thanks');
      expect(result.complexity).toBe('simple');
    });

    test('应该将简单问答分类为 simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('什么是 TypeScript');
      expect(result.complexity).toBe('simple');
    });
  });

  describe('上下文信号', () => {
    test('最近使用过工具应该分类为 complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('继续', {
        hasRecentToolUse: true,
      });
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('工具');
    });
  });

  describe('LLM 兜底分类', () => {
    test('模糊消息应该调用 LLM 分类', async () => {
      const mockLLM = createMockLightLLM();
      const completeSpy = spyOn(mockLLM, 'complete');
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(completeSpy).toHaveBeenCalled();
      expect(result.classifiedBy).toBe('llm');
    });

    test('LLM 返回 simple 时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"complexity":"simple","reason":"闲聊"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.complexity).toBe('simple');
      expect(result.costUsd).toBe(0.0001);
    });

    test('LLM 返回 complex 时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"complexity":"complex","reason":"需要工具"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0002 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.complexity).toBe('complex');
    });

    test('LLM 不可用时保守默认为 complex', async () => {
      const classifier = new TaskClassifier(null);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('未配置');
    });

    test('LLM 调用失败时保守默认为 complex', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => {
          throw new Error('API error');
        },
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('失败');
    });

    test('LLM 返回无效 JSON 时保守默认为 complex', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: 'not valid json',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.complexity).toBe('complex');
    });
  });

  describe('统计数据', () => {
    test('应该正确追踪统计数据', async () => {
      const classifier = new TaskClassifier();

      await classifier.classify('你好'); // rule, simple
      await classifier.classify('/deploy'); // rule, complex
      await classifier.classify('谢谢'); // rule, simple

      const stats = classifier.getStats();
      expect(stats.total).toBe(3);
      expect(stats.ruleClassified).toBe(3);
      expect(stats.simpleCount).toBe(2);
      expect(stats.complexCount).toBe(1);
    });

    test('应该能重置统计数据', async () => {
      const classifier = new TaskClassifier();
      await classifier.classify('你好');
      classifier.resetStats();
      const stats = classifier.getStats();
      expect(stats.total).toBe(0);
    });
  });
});
