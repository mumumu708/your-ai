import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AlertEvaluator, type AlertRule, DEFAULT_ALERT_RULES } from './alert-rules';
import type { ToolCallStats } from './tool-call-monitor';

describe('AlertRules', () => {
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

  function createStats(overrides: Partial<ToolCallStats> = {}): ToolCallStats {
    return {
      total: 0,
      successCount: 0,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: 0,
      consecutiveErrors: 0,
      ...overrides,
    };
  }

  describe('DEFAULT_ALERT_RULES', () => {
    test('应该定义3个默认规则', () => {
      expect(DEFAULT_ALERT_RULES.length).toBe(3);
    });

    test('high_error_rate 规则应该在 total>10 且 errorRate>0.3 时触发', () => {
      const rule = DEFAULT_ALERT_RULES.find((r) => r.name === 'mcp_tool_high_error_rate');
      if (!rule) throw new Error('Expected to find mcp_tool_high_error_rate rule');
      expect(rule.condition(createStats({ total: 20, errorRate: 0.5 }))).toBe(true);
      expect(rule.condition(createStats({ total: 5, errorRate: 0.5 }))).toBe(false);
      expect(rule.condition(createStats({ total: 20, errorRate: 0.1 }))).toBe(false);
    });

    test('high_latency 规则应该在 avgDurationMs>10000 时触发', () => {
      const rule = DEFAULT_ALERT_RULES.find((r) => r.name === 'mcp_tool_high_latency');
      if (!rule) throw new Error('Expected to find mcp_tool_high_latency rule');
      expect(rule.condition(createStats({ avgDurationMs: 15000 }))).toBe(true);
      expect(rule.condition(createStats({ avgDurationMs: 5000 }))).toBe(false);
    });

    test('server_unreachable 规则应该在 consecutiveErrors>5 时触发', () => {
      const rule = DEFAULT_ALERT_RULES.find((r) => r.name === 'mcp_server_unreachable');
      if (!rule) throw new Error('Expected to find mcp_server_unreachable rule');
      expect(rule.condition(createStats({ consecutiveErrors: 6 }))).toBe(true);
      expect(rule.condition(createStats({ consecutiveErrors: 3 }))).toBe(false);
    });
  });

  describe('AlertEvaluator', () => {
    test('应该返回触发的告警', () => {
      const evaluator = new AlertEvaluator();
      const alerts = evaluator.evaluate(
        createStats({
          total: 20,
          errorRate: 0.5,
          avgDurationMs: 15000,
          consecutiveErrors: 10,
        }),
      );

      expect(alerts.length).toBe(3);
      expect(alerts.map((a) => a.ruleName)).toContain('mcp_tool_high_error_rate');
      expect(alerts.map((a) => a.ruleName)).toContain('mcp_tool_high_latency');
      expect(alerts.map((a) => a.ruleName)).toContain('mcp_server_unreachable');
    });

    test('正常状态应该不触发告警', () => {
      const evaluator = new AlertEvaluator();
      const alerts = evaluator.evaluate(
        createStats({
          total: 100,
          errorRate: 0.01,
          avgDurationMs: 500,
          consecutiveErrors: 0,
        }),
      );

      expect(alerts.length).toBe(0);
    });

    test('应该累积历史告警', () => {
      const evaluator = new AlertEvaluator();
      evaluator.evaluate(createStats({ consecutiveErrors: 10 }));
      evaluator.evaluate(createStats({ avgDurationMs: 20000 }));

      expect(evaluator.getFiredAlerts().length).toBe(2);
    });

    test('应该支持自定义规则', () => {
      const customRules: AlertRule[] = [
        {
          name: 'custom_rule',
          description: 'Custom alert',
          condition: (stats) => stats.total > 5,
          severity: 'warning',
          action: 'notify',
        },
      ];

      const evaluator = new AlertEvaluator(customRules);
      const alerts = evaluator.evaluate(createStats({ total: 10 }));
      expect(alerts.length).toBe(1);
      expect(alerts[0].ruleName).toBe('custom_rule');
    });
  });
});
