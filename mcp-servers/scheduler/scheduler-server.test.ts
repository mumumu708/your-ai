import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { McpServerBase } from '../shared/mcp-server-base';
import { createAuthMiddleware } from '../shared/auth-middleware';

describe('Scheduler MCP Server', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.YOURBOT_USER_ID = 'user_001';
    process.env.YOURBOT_TENANT_ID = 'tenant_001';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createSchedulerServer(): McpServerBase {
    const server = new McpServerBase({ name: 'scheduler-server', version: '1.0.0' });
    const auth = createAuthMiddleware();
    const tasks = new Map<string, { id: string; name: string; status: string; userId: string }>();

    server.tool('schedule_create', '创建定时任务', {
      name: { type: 'string' },
      triggerAt: { type: 'string' },
    }, async (input) => {
      const { name, triggerAt } = input as { name: string; triggerAt: string };
      const id = `sched_test_${tasks.size}`;
      tasks.set(id, { id, name, status: 'active', userId: auth.getContext().userId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true, taskId: id, nextTrigger: triggerAt,
        })}],
      };
    });

    server.tool('schedule_list', '列出定时任务', {}, async () => {
      const userId = auth.getContext().userId;
      const userTasks = Array.from(tasks.values()).filter(t => t.userId === userId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          tasks: userTasks, total: userTasks.length,
        })}],
      };
    });

    server.tool('schedule_cancel', '取消定时任务', {
      taskId: { type: 'string' },
    }, async (input) => {
      const { taskId } = input as { taskId: string };
      const task = tasks.get(taskId);
      if (!task) {
        return { content: [{ type: 'text' as const, text: '{"success":false}' }], isError: true };
      }
      auth.assertAccess(task.userId);
      task.status = 'cancelled';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, cancelled: taskId }) }],
      };
    });

    return server;
  }

  test('应该注册定时任务相关工具', () => {
    const server = createSchedulerServer();
    const tools = server.getToolDefinitions();
    expect(tools.map(t => t.name)).toContain('schedule_create');
    expect(tools.map(t => t.name)).toContain('schedule_list');
    expect(tools.map(t => t.name)).toContain('schedule_cancel');
  });

  test('schedule_create 应该创建任务', async () => {
    const server = createSchedulerServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'schedule_create',
        arguments: { name: '每天喝水提醒', triggerAt: '2024-01-01T09:00:00Z' },
      },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.taskId).toBeDefined();
    expect(data.nextTrigger).toBe('2024-01-01T09:00:00Z');
  });

  test('schedule_list 应该列出用户任务', async () => {
    const server = createSchedulerServer();

    // Create 2 tasks
    await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'schedule_create', arguments: { name: 'Task 1', triggerAt: '2024-01-01T09:00:00Z' } },
    });
    await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'schedule_create', arguments: { name: 'Task 2', triggerAt: '2024-01-02T10:00:00Z' } },
    });

    // List
    const response = await server.handleRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'schedule_list', arguments: {} },
    });

    const result = response!.result as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.total).toBe(2);
  });

  test('schedule_cancel 应该取消任务', async () => {
    const server = createSchedulerServer();

    // Create
    const createResp = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'schedule_create', arguments: { name: 'To Cancel', triggerAt: '2024-01-01T09:00:00Z' } },
    });
    const createResult = (createResp!.result as { content: Array<{ text: string }> }).content[0].text;
    const taskId = JSON.parse(createResult).taskId;

    // Cancel
    const cancelResp = await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'schedule_cancel', arguments: { taskId } },
    });

    const cancelResult = (cancelResp!.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(cancelResult).success).toBe(true);
  });
});
