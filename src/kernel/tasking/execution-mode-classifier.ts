import type { ExecutionMode } from '../../shared/tasking/task.types';

export function classifyExecutionMode(params: {
  taskType: string;
  complexity: string;
  source: string;
  content: string;
}): ExecutionMode {
  // Harness always long-horizon
  if (params.taskType === 'harness') return 'long-horizon';

  // System/scheduler tasks are async
  if (params.source === 'scheduler' || params.source === 'system') return 'async';

  // User explicitly requests background
  if (/后台|background|异步/i.test(params.content)) return 'async';

  // Long-horizon detection heuristics
  if (isLongHorizon(params.content)) return 'long-horizon';

  // Default: sync
  return 'sync';
}

function isLongHorizon(content: string): boolean {
  const patterns = [
    /深度研究|deep\s*research/i,
    /全面分析|comprehensive\s*analysis/i,
    /写一份.*报告|write.*report/i,
    /代码重构|refactor/i,
    /批量.*处理|batch.*process/i,
  ];
  return patterns.some((p) => p.test(content));
}
