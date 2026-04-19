import { describe, expect, test } from 'bun:test';
import { classifyExecutionMode } from './execution-mode-classifier';

describe('classifyExecutionMode', () => {
  // ── Harness → long-horizon ──

  test('harness 类型始终返回 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'harness',
        complexity: 'simple',
        source: 'user',
        content: '你好',
      }),
    ).toBe('long-horizon');
  });

  // ── Scheduler/System → async ──

  test('scheduler 来源返回 async', () => {
    expect(
      classifyExecutionMode({
        taskType: 'scheduled',
        complexity: 'simple',
        source: 'scheduler',
        content: '定时任务',
      }),
    ).toBe('async');
  });

  test('system 来源返回 async', () => {
    expect(
      classifyExecutionMode({
        taskType: 'system',
        complexity: 'simple',
        source: 'system',
        content: '系统反思',
      }),
    ).toBe('async');
  });

  // ── User requests background → async ──

  test('用户请求"后台"执行返回 async', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '帮我后台处理这个文件',
      }),
    ).toBe('async');
  });

  test('用户请求 background 返回 async', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: 'process this in the background',
      }),
    ).toBe('async');
  });

  test('用户请求"异步"执行返回 async', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '异步帮我分析一下',
      }),
    ).toBe('async');
  });

  // ── Long-horizon detection ──

  test('"深度研究"触发 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '帮我做一个深度研究',
      }),
    ).toBe('long-horizon');
  });

  test('"deep research" 触发 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: 'Do a deep research on this topic',
      }),
    ).toBe('long-horizon');
  });

  test('"全面分析"触发 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '请全面分析这个项目',
      }),
    ).toBe('long-horizon');
  });

  test('"写一份报告"触发 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '写一份市场调研报告',
      }),
    ).toBe('long-horizon');
  });

  test('"代码重构"触发 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '帮我做代码重构',
      }),
    ).toBe('long-horizon');
  });

  test('"批量处理"触发 long-horizon', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '批量数据处理一下',
      }),
    ).toBe('long-horizon');
  });

  // ── Default → sync ──

  test('普通聊天返回 sync', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'simple',
        source: 'user',
        content: '今天天气怎么样',
      }),
    ).toBe('sync');
  });

  test('复杂但无特殊标记的任务返回 sync', () => {
    expect(
      classifyExecutionMode({
        taskType: 'chat',
        complexity: 'complex',
        source: 'user',
        content: '帮我翻译一段话',
      }),
    ).toBe('sync');
  });
});
