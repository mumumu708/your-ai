import type { ErrorCode } from './error-codes';

export class YourBotError extends Error {
  public readonly code: ErrorCode;
  public readonly timestamp: number;
  public readonly context: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'YourBotError';
    this.code = code;
    this.timestamp = Date.now();
    this.context = context;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
      context: this.context,
    };
  }
}
