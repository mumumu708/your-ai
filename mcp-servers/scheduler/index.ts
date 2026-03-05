/**
 * YourBot 定时任务管理 MCP Server
 *
 * Provides tools for scheduled task management:
 * - schedule_create: Create a scheduled/recurring task
 * - schedule_list: List user's scheduled tasks
 * - schedule_cancel: Cancel a scheduled task
 * - schedule_update: Update a scheduled task
 *
 * This server is started by Claude Code via .mcp.json configuration.
 */

import { McpServerBase } from '../shared/mcp-server-base';
import { createAuthMiddleware } from '../shared/auth-middleware';

const server = new McpServerBase({
  name: 'scheduler-server',
  version: '1.0.0',
  description: 'YourBot 定时任务管理',
});

const auth = createAuthMiddleware();

// In-memory store for development (replace with SQLite in production)
const taskStore = new Map<string, {
  id: string;
  name: string;
  description: string;
  triggerAt: string;
  recurring?: { enabled: boolean; cron?: string };
  action: { type: string; payload: Record<string, unknown> };
  userId: string;
  status: 'active' | 'cancelled';
  createdAt: number;
}>();

server.tool(
  'schedule_create',
  '创建一个定时任务，到达指定时间后自动触发执行',
  {
    name: { type: 'string', description: '任务名称' },
    description: { type: 'string', description: '任务描述' },
    triggerAt: { type: 'string', description: '触发时间 (ISO 8601)' },
    recurring: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        cron: { type: 'string', description: 'cron 表达式' },
      },
      description: '循环配置',
    },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['send_message', 'run_prompt'] },
        payload: { type: 'object', description: '动作参数' },
      },
      description: '触发时执行的动作',
    },
  },
  async (input) => {
    const { name, description, triggerAt, recurring, action } = input as {
      name: string;
      description: string;
      triggerAt: string;
      recurring?: { enabled: boolean; cron?: string };
      action: { type: string; payload: Record<string, unknown> };
    };

    const id = `sched_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const userId = auth.getContext().userId;

    taskStore.set(id, {
      id,
      name,
      description,
      triggerAt,
      recurring,
      action,
      userId,
      status: 'active',
      createdAt: Date.now(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          taskId: id,
          nextTrigger: triggerAt,
        }),
      }],
    };
  },
);

server.tool(
  'schedule_list',
  '列出用户的定时任务',
  {
    status: { type: 'string', enum: ['active', 'cancelled', 'all'], description: '过滤状态' },
  },
  async (input) => {
    const { status } = input as { status?: string };
    const userId = auth.getContext().userId;

    const tasks = Array.from(taskStore.values())
      .filter(t => t.userId === userId)
      .filter(t => !status || status === 'all' || t.status === status)
      .map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        triggerAt: t.triggerAt,
        recurring: t.recurring,
        status: t.status,
      }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ tasks, total: tasks.length }),
      }],
    };
  },
);

server.tool(
  'schedule_cancel',
  '取消一个定时任务',
  {
    taskId: { type: 'string', description: '任务 ID' },
  },
  async (input) => {
    const { taskId } = input as { taskId: string };
    const task = taskStore.get(taskId);

    if (!task) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Task not found' }) }],
        isError: true,
      };
    }

    auth.assertAccess(task.userId);
    task.status = 'cancelled';

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ success: true, cancelled: taskId }),
      }],
    };
  },
);

server.tool(
  'schedule_update',
  '更新定时任务的配置',
  {
    taskId: { type: 'string', description: '任务 ID' },
    triggerAt: { type: 'string', description: '新的触发时间 (ISO 8601)' },
    name: { type: 'string', description: '新的任务名称' },
  },
  async (input) => {
    const { taskId, triggerAt, name } = input as {
      taskId: string; triggerAt?: string; name?: string;
    };
    const task = taskStore.get(taskId);

    if (!task) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Task not found' }) }],
        isError: true,
      };
    }

    auth.assertAccess(task.userId);

    if (triggerAt) task.triggerAt = triggerAt;
    if (name) task.name = name;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ success: true, updated: taskId }),
      }],
    };
  },
);

// Start server
server.run();
