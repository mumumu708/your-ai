export const LOG_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function isLevelEnabled(current: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_PRIORITY[current] >= LEVEL_PRIORITY[threshold];
}
