export interface StreamBufferOptions {
  /** Minimum interval between flushes in ms. Default: 100 */
  flushIntervalMs?: number;
  /** Maximum buffer size before forcing a flush. Default: 500 chars */
  maxBufferSize?: number;
}

export class StreamBuffer {
  private buffer = '';
  private lastFlushTime = 0;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;

  constructor(options: StreamBufferOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 100;
    this.maxBufferSize = options.maxBufferSize ?? 500;
  }

  append(text: string): void {
    this.buffer += text;
  }

  shouldFlush(): boolean {
    if (this.buffer.length === 0) return false;
    if (this.buffer.length >= this.maxBufferSize) return true;

    const now = Date.now();
    return now - this.lastFlushTime >= this.flushIntervalMs;
  }

  flush(): string {
    const content = this.buffer;
    this.buffer = '';
    this.lastFlushTime = Date.now();
    return content;
  }

  /** Force flush remaining content, regardless of timing */
  forceFlush(): string {
    return this.flush();
  }

  getBufferLength(): number {
    return this.buffer.length;
  }

  isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  reset(): void {
    this.buffer = '';
    this.lastFlushTime = 0;
  }
}
