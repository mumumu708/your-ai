import { Logger } from '../../shared/logging/logger';
import type { ToolCallStats } from './tool-call-monitor';

// --- Types ---

export type AlertSeverity = 'warning' | 'critical';
export type AlertAction = 'notify' | 'notify_and_log';

export interface AlertRule {
  name: string;
  description: string;
  condition: (stats: ToolCallStats) => boolean;
  severity: AlertSeverity;
  action: AlertAction;
}

export interface AlertEvent {
  ruleName: string;
  severity: AlertSeverity;
  action: AlertAction;
  description: string;
  stats: ToolCallStats;
  timestamp: number;
}

// --- Default Rules ---

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    name: 'mcp_tool_high_error_rate',
    description: '工具调用错误率超过阈值',
    condition: (stats) => stats.total > 10 && stats.errorRate > 0.3,
    severity: 'warning',
    action: 'notify',
  },
  {
    name: 'mcp_tool_high_latency',
    description: '工具调用平均延迟超过阈值',
    condition: (stats) => stats.avgDurationMs > 10_000,
    severity: 'warning',
    action: 'notify',
  },
  {
    name: 'mcp_server_unreachable',
    description: 'MCP Server 持续无响应',
    condition: (stats) => stats.consecutiveErrors > 5,
    severity: 'critical',
    action: 'notify_and_log',
  },
];

// --- Evaluator ---

export class AlertEvaluator {
  private readonly logger = new Logger('AlertEvaluator');
  private readonly rules: AlertRule[];
  private readonly firedAlerts: AlertEvent[] = [];

  constructor(rules?: AlertRule[]) {
    this.rules = rules ?? DEFAULT_ALERT_RULES;
  }

  /**
   * Evaluate all rules against current stats.
   * Returns any newly fired alerts.
   */
  evaluate(stats: ToolCallStats): AlertEvent[] {
    const fired: AlertEvent[] = [];

    for (const rule of this.rules) {
      if (rule.condition(stats)) {
        const event: AlertEvent = {
          ruleName: rule.name,
          severity: rule.severity,
          action: rule.action,
          description: rule.description,
          stats: { ...stats },
          timestamp: Date.now(),
        };
        fired.push(event);
        this.firedAlerts.push(event);

        this.logger.error('告警触发', {
          rule: rule.name,
          severity: rule.severity,
          errorRate: stats.errorRate,
          avgDurationMs: stats.avgDurationMs,
          consecutiveErrors: stats.consecutiveErrors,
        });
      }
    }

    return fired;
  }

  getFiredAlerts(): readonly AlertEvent[] {
    return this.firedAlerts;
  }
}
