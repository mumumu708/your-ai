import { describe, expect, test } from 'bun:test';
import { StreamBuffer } from './stream-buffer';

describe('StreamBuffer', () => {
  describe('append / flush', () => {
    test('应该累积文本并在 flush 时返回', () => {
      const buffer = new StreamBuffer();
      buffer.append('Hello');
      buffer.append(' World');
      expect(buffer.flush()).toBe('Hello World');
    });

    test('flush 后 buffer 应该为空', () => {
      const buffer = new StreamBuffer();
      buffer.append('text');
      buffer.flush();
      expect(buffer.isEmpty()).toBe(true);
      expect(buffer.flush()).toBe('');
    });
  });

  describe('shouldFlush', () => {
    test('空 buffer 不应该 flush', () => {
      const buffer = new StreamBuffer();
      expect(buffer.shouldFlush()).toBe(false);
    });

    test('超过 maxBufferSize 应该 flush', () => {
      const buffer = new StreamBuffer({ maxBufferSize: 10 });
      buffer.append('12345678901'); // 11 chars > 10
      expect(buffer.shouldFlush()).toBe(true);
    });

    test('超过 flushIntervalMs 应该 flush', async () => {
      const buffer = new StreamBuffer({ flushIntervalMs: 10 });
      buffer.append('text');
      // First call after creation should flush (lastFlushTime is 0)
      expect(buffer.shouldFlush()).toBe(true);
    });

    test('在 flushInterval 内不应该 flush', () => {
      const buffer = new StreamBuffer({ flushIntervalMs: 10000 });
      buffer.append('text');
      buffer.flush(); // Reset timer
      buffer.append('more');
      expect(buffer.shouldFlush()).toBe(false);
    });
  });

  describe('forceFlush', () => {
    test('应该无条件清空 buffer', () => {
      const buffer = new StreamBuffer({ flushIntervalMs: 999999 });
      buffer.append('forced');
      expect(buffer.forceFlush()).toBe('forced');
      expect(buffer.isEmpty()).toBe(true);
    });
  });

  describe('getBufferLength', () => {
    test('应该返回当前 buffer 长度', () => {
      const buffer = new StreamBuffer();
      expect(buffer.getBufferLength()).toBe(0);
      buffer.append('hello');
      expect(buffer.getBufferLength()).toBe(5);
    });
  });

  describe('reset', () => {
    test('应该清空 buffer 并重置时间', () => {
      const buffer = new StreamBuffer();
      buffer.append('text');
      buffer.flush();
      buffer.append('more');
      buffer.reset();
      expect(buffer.isEmpty()).toBe(true);
    });
  });
});
