import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { LightLLMClient } from '../agents/light-llm-client';
import { TaskClassifier } from './task-classifier';

function createMockLightLLM(overrides: Partial<LightLLMClient> = {}): LightLLMClient {
  return {
    complete: async () => ({
      content: '{"taskType":"chat","complexity":"simple","reason":"test"}',
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

  describe('规则分类 - harness 显式触发', () => {
    test('应该将 /harness 命令分类为 harness + complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('/harness 修改代码');
      expect(result.taskType).toBe('harness');
      expect(result.complexity).toBe('complex');
      expect(result.classifiedBy).toBe('rule');
      expect(result.costUsd).toBe(0);
    });

    test('应该将 harness: 前缀分类为 harness + complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('harness: fix the bug');
      expect(result.taskType).toBe('harness');
      expect(result.complexity).toBe('complex');
    });
  });

  describe('规则分类 - system 命令', () => {
    test('应该将斜杠命令分类为 system + complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('/status');
      expect(result.taskType).toBe('system');
      expect(result.complexity).toBe('complex');
      expect(result.classifiedBy).toBe('rule');
    });

    test('应该将 /help 分类为 system', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('/help');
      expect(result.taskType).toBe('system');
    });

    test('/harness 应优先于 system 分类', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('/harness deploy');
      expect(result.taskType).toBe('harness');
    });
  });

  describe('规则分类 - scheduled 任务', () => {
    test('应该将"每天"分类为 scheduled', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('每天早上提醒我喝水');
      expect(result.taskType).toBe('scheduled');
      expect(result.complexity).toBe('complex');
    });

    test('应该将"提醒我"分类为 scheduled', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('提醒我下午3点开会');
      expect(result.taskType).toBe('scheduled');
    });

    test('应该将 remind 分类为 scheduled', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('remind me every day at 9:00');
      expect(result.taskType).toBe('scheduled');
    });
  });

  describe('规则分类 - automation 任务', () => {
    test('应该将"批量"分类为 automation', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('批量处理这些文件');
      expect(result.taskType).toBe('automation');
      expect(result.complexity).toBe('complex');
    });

    test('应该将 batch 分类为 automation', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('batch process these files');
      expect(result.taskType).toBe('automation');
    });
  });

  describe('规则分类 - simple 模式', () => {
    test('应该将超短消息分类为 chat + simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('你好');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
      expect(result.classifiedBy).toBe('rule');
    });

    test('应该将纯问候分类为 chat + simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('hello!');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
    });

    test('应该将翻译请求分类为 chat + simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('翻译: Hello World');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
    });

    test('应该将简单回复分类为 chat + simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('谢谢');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
    });

    test('应该将 thanks 分类为 chat + simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('thanks');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
    });

    test('应该将简单问答分类为 chat + simple', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('什么是 TypeScript');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
    });
  });

  describe('上下文信号', () => {
    test('最近使用过工具应该分类为 chat + complex', async () => {
      const classifier = new TaskClassifier();
      const result = await classifier.classify('继续', {
        hasRecentToolUse: true,
      });
      expect(result.taskType).toBe('chat');
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

    test('LLM 返回 chat + simple 时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"taskType":"chat","complexity":"simple","reason":"闲聊"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
      expect(result.costUsd).toBe(0.0001);
    });

    test('LLM 返回 harness 时应降级为 chat（harness 仅限显式命令）', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"taskType":"harness","complexity":"complex","reason":"需要修改代码"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0002 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('从skills同步最新内容，替换本地内置的skill');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
    });

    test('LLM 返回 complex 时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"taskType":"chat","complexity":"complex","reason":"需要工具"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0002 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
    });

    test('LLM 不可用时保守默认为 chat + complex', async () => {
      const classifier = new TaskClassifier(null);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('未配置');
    });

    test('LLM 调用失败时保守默认为 chat + complex', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => {
          throw new Error('API error');
        },
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('失败');
    });

    test('LLM 返回无效 JSON 时保守默认为 chat + complex', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: 'not valid json',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('格式异常');
    });

    test('LLM 返回 markdown 代码块包裹的 JSON 时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '```json\n{"taskType":"chat","complexity":"simple","reason":"简单问候"}\n```',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
      expect(result.reason).toBe('简单问候');
    });

    test('LLM 返回无语言标记代码块时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '```\n{"taskType":"chat","complexity":"complex","reason":"需要工具"}\n```',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toBe('需要工具');
    });

    test('LLM 返回 JSON 前后有多余文本时正确解析', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '分类结果如下：{"taskType":"chat","complexity":"simple","reason":"闲聊"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('simple');
    });

    test('LLM 返回未知 taskType 时回退到 chat', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"taskType":"unknown","complexity":"complex","reason":"test"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
    });

    test('LLM 调用失败时 reason 包含具体错误信息', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => {
          throw new Error('LightLLM API 错误: 401');
        },
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      const result = await classifier.classify('能不能帮我看看这个东西好不好用');
      expect(result.taskType).toBe('chat');
      expect(result.complexity).toBe('complex');
      expect(result.reason).toContain('401');
    });

    test('LLM 路径应该打印统一分类结果日志', async () => {
      const mockLLM = createMockLightLLM({
        complete: async () => ({
          content: '{"taskType":"chat","complexity":"complex","reason":"需要推理"}',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
        }),
      } as unknown as Partial<LightLLMClient>);
      const classifier = new TaskClassifier(mockLLM);
      await classifier.classify('能不能帮我看看这个东西好不好用');

      // Logger.info is implemented via console.log
      const logCalls = logSpy.mock.calls;
      const hasClassifyLog = logCalls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('统一分类结果'),
      );
      expect(hasClassifyLog).toBe(true);
    });
  });

  describe('统计数据', () => {
    test('应该正确追踪统计数据', async () => {
      const classifier = new TaskClassifier();

      await classifier.classify('你好'); // rule, simple
      await classifier.classify('/status'); // rule, complex (system)
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
