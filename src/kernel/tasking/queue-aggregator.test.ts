import { describe, expect, test } from 'bun:test';
import { QueueAggregator } from './queue-aggregator';

describe('QueueAggregator', () => {
  const agg = new QueueAggregator();

  test('空消息列表返回空结果', async () => {
    const result = await agg.aggregate([]);
    expect(result.tasks).toEqual([]);
    expect(result.filtered).toEqual([]);
    expect(result.reason).toBe('single');
  });

  test('单条消息直接透传', async () => {
    const result = await agg.aggregate(['查天气']);
    expect(result.tasks).toEqual([{ message: '查天气', original: ['查天气'] }]);
    expect(result.filtered).toEqual([]);
    expect(result.reason).toBe('single');
  });

  // ── Noise filtering ──

  test('过滤纯数字噪声', async () => {
    const result = await agg.aggregate(['123', '查天气']);
    expect(result.tasks).toEqual([{ message: '查天气', original: ['查天气'] }]);
    expect(result.filtered).toEqual(['123']);
    expect(result.reason).toBe('single_after_filter');
  });

  test('过滤纯表情/符号', async () => {
    const result = await agg.aggregate(['👍', '帮我查一下明天的航班']);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('帮我查一下明天的航班');
    expect(result.filtered).toEqual(['👍']);
  });

  test('过滤短问候语', async () => {
    const result = await agg.aggregate(['在吗', '你好', '帮我订个机票']);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('帮我订个机票');
    expect(result.filtered).toContain('在吗');
    expect(result.filtered).toContain('你好');
  });

  test('全部是噪声时返回空任务', async () => {
    const result = await agg.aggregate(['123', '👍', 'ok']);
    expect(result.tasks).toEqual([]);
    expect(result.filtered.length).toBe(3);
    expect(result.reason).toBe('all_noise');
  });

  // ── Override detection ──

  test('检测到覆盖模式时保留最后一条', async () => {
    const result = await agg.aggregate(['查北京天气', '不是，查上海天气']);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('不是，查上海天气');
    expect(result.tasks[0]!.original).toEqual(['查北京天气', '不是，查上海天气']);
    expect(result.reason).toBe('last_override');
  });

  test('检测"我是说"覆盖模式', async () => {
    const result = await agg.aggregate(['帮我查航班', '我是说帮我查火车票']);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('我是说帮我查火车票');
    expect(result.reason).toBe('last_override');
  });

  test('检测"算了"覆盖模式', async () => {
    const result = await agg.aggregate(['帮我查航班', '算了不查了']);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('算了不查了');
    expect(result.reason).toBe('last_override');
  });

  // ── Multiple meaningful, no override ──

  test('多条独立消息保持独立', async () => {
    const result = await agg.aggregate(['查北京天气', '帮我订机票']);
    expect(result.tasks.length).toBe(2);
    expect(result.tasks[0]!.message).toBe('查北京天气');
    expect(result.tasks[1]!.message).toBe('帮我订机票');
    expect(result.reason).toBe('independent');
  });

  // ── LLM fallback ──

  test('LLM 合并多条有意义消息', async () => {
    const llm = async (_prompt: string) => '查北京和上海的天气';
    const result = await agg.aggregate(['查北京天气', '还有上海的'], llm);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('查北京和上海的天气');
    expect(result.tasks[0]!.original).toEqual(['查北京天气', '还有上海的']);
    expect(result.reason).toBe('llm_merged');
  });

  test('LLM 失败时回退到独立任务', async () => {
    const llm = async (_prompt: string): Promise<string> => {
      throw new Error('LLM unavailable');
    };
    const result = await agg.aggregate(['查北京天气', '帮我订机票'], llm);
    expect(result.tasks.length).toBe(2);
    expect(result.reason).toBe('independent');
  });

  test('无 LLM 时多条消息保持独立', async () => {
    const result = await agg.aggregate(['查北京天气', '帮我订机票']);
    expect(result.tasks.length).toBe(2);
    expect(result.reason).toBe('independent');
  });

  // ── Mixed noise + meaningful ──

  test('噪声和有意义消息混合', async () => {
    const result = await agg.aggregate(['666', '在吗', '查北京天气', '👍', '帮我订机票']);
    expect(result.tasks.length).toBe(2);
    expect(result.tasks[0]!.message).toBe('查北京天气');
    expect(result.tasks[1]!.message).toBe('帮我订机票');
    expect(result.filtered.length).toBe(3);
    expect(result.reason).toBe('independent');
  });

  // ── Edge: noise + override ──

  test('噪声过滤后剩余消息有覆盖关系', async () => {
    const result = await agg.aggregate(['hi', '查北京天气', '不对，查上海天气']);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.message).toBe('不对，查上海天气');
    expect(result.filtered).toEqual(['hi']);
    expect(result.reason).toBe('last_override');
  });
});
