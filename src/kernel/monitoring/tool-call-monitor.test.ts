import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { type ClaudeStreamEvent, type ToolCallLogSink, ToolCallMonitor } from './tool-call-monitor';

describe('ToolCallMonitor', () => {
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

  describe('extractServerId', () => {
    test('应该从 MCP 工具名中提取 Server ID', () => {
      const monitor = new ToolCallMonitor();
      expect(monitor.extractServerId('mcp__feishu_server__send_message')).toBe('feishu_server');
      expect(monitor.extractServerId('mcp__memory_server__store')).toBe('memory_server');
    });

    test('非 MCP 工具名应该返回 unknown', () => {
      const monitor = new ToolCallMonitor();
      expect(monitor.extractServerId('Bash')).toBe('unknown');
      expect(monitor.extractServerId('Read')).toBe('unknown');
    });
  });

  describe('processStreamEvent', () => {
    test('content_block_start 应该注册活跃调用', () => {
      const monitor = new ToolCallMonitor();
      const event: ClaudeStreamEvent = {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tc_001',
          name: 'mcp__feishu_server__send_message',
        },
      };

      monitor.processStreamEvent('sess_001', event);
      expect(monitor.getActiveCallCount()).toBe(1);
    });

    test('content_block_stop 应该完成工具调用', () => {
      const monitor = new ToolCallMonitor();

      // Start
      monitor.processStreamEvent('sess_001', {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tc_001',
          name: 'mcp__memory_server__store',
        },
      });

      // Stop
      monitor.processStreamEvent('sess_001', {
        type: 'content_block_stop',
        id: 'tc_001',
      });

      expect(monitor.getActiveCallCount()).toBe(0);
      const completed = monitor.getCompletedEvents();
      expect(completed.length).toBe(1);
      expect(completed[0].status).toBe('success');
      expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    test('tool_result error 应该标记为错误', () => {
      const monitor = new ToolCallMonitor();

      monitor.processStreamEvent('sess_001', {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tc_002',
          name: 'mcp__feishu_server__read_doc',
        },
      });

      monitor.processStreamEvent('sess_001', {
        type: 'tool_result',
        is_error: true,
        content: 'Document not found',
      });

      const completed = monitor.getCompletedEvents();
      expect(completed.length).toBe(1);
      expect(completed[0].status).toBe('error');
      expect(completed[0].errorMessage).toBe('Document not found');
    });

    test('非 tool_use 的 content_block_start 应该被忽略', () => {
      const monitor = new ToolCallMonitor();
      monitor.processStreamEvent('sess_001', {
        type: 'content_block_start',
        content_block: {
          type: 'text',
          id: 'txt_001',
          name: '',
        },
      });
      expect(monitor.getActiveCallCount()).toBe(0);
    });
  });

  describe('getStats', () => {
    test('应该计算正确的统计数据', () => {
      const monitor = new ToolCallMonitor();

      // 2 successes
      for (let i = 0; i < 2; i++) {
        monitor.processStreamEvent('sess', {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: `ok_${i}`, name: 'mcp__s__tool' },
        });
        monitor.processStreamEvent('sess', {
          type: 'content_block_stop',
          id: `ok_${i}`,
        });
      }

      // 1 error
      monitor.processStreamEvent('sess', {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'err_0', name: 'mcp__s__tool' },
      });
      monitor.processStreamEvent('sess', {
        type: 'tool_result',
        is_error: true,
        content: 'fail',
      });

      const stats = monitor.getStats();
      expect(stats.total).toBe(3);
      expect(stats.successCount).toBe(2);
      expect(stats.errorCount).toBe(1);
      expect(stats.errorRate).toBeCloseTo(1 / 3, 2);
      expect(stats.consecutiveErrors).toBe(1);
    });

    test('空状态应该返回零值', () => {
      const monitor = new ToolCallMonitor();
      const stats = monitor.getStats();
      expect(stats.total).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
    });

    test('连续错误计数应该在成功后重置', () => {
      const monitor = new ToolCallMonitor();

      // Error
      monitor.processStreamEvent('s', {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'e1', name: 'mcp__s__t' },
      });
      monitor.processStreamEvent('s', {
        type: 'tool_result',
        is_error: true,
        content: 'err',
      });

      expect(monitor.getStats().consecutiveErrors).toBe(1);

      // Success
      monitor.processStreamEvent('s', {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 's1', name: 'mcp__s__t' },
      });
      monitor.processStreamEvent('s', {
        type: 'content_block_stop',
        id: 's1',
      });

      expect(monitor.getStats().consecutiveErrors).toBe(0);
    });
  });

  describe('logSink', () => {
    test('应该将完成的事件持久化到 sink', async () => {
      const persisted: unknown[] = [];
      const sink: ToolCallLogSink = {
        persist: async (event) => {
          persisted.push(event);
        },
      };

      const monitor = new ToolCallMonitor(sink);

      monitor.processStreamEvent('sess', {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tc1', name: 'mcp__s__t' },
      });
      monitor.processStreamEvent('sess', {
        type: 'content_block_stop',
        id: 'tc1',
      });

      // Wait for async persist
      await new Promise((r) => setTimeout(r, 10));
      expect(persisted.length).toBe(1);
    });
  });
});
