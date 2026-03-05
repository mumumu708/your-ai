import { LOG_LEVELS, type LogLevel, isLevelEnabled } from './log-levels';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  traceId?: string;
  [key: string]: unknown;
}

export class Logger {
  private static globalLevel: LogLevel = LOG_LEVELS.INFO;

  constructor(private readonly module: string) {}

  static setLevel(level: LogLevel): void {
    Logger.globalLevel = level;
  }

  static getLevel(): LogLevel {
    return Logger.globalLevel;
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.INFO, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.WARN, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.ERROR, message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LOG_LEVELS.DEBUG, message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!isLevelEnabled(level, Logger.globalLevel)) {
      return;
    }
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...context,
    };
    const output = JSON.stringify(entry);
    if (level === LOG_LEVELS.ERROR || level === LOG_LEVELS.WARN) {
      console.error(output);
    } else {
      console.log(output);
    }
  }
}
