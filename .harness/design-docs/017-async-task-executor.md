# DD-017: 任务调度与状态持久化

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-12
- **上游**: [DD-011](011-architecture-upgrade-v2.md)
- **下游**: [DD-012](012-memory-reflection-upgrade.md)（后台反思）、[DD-013](013-task-scheduling-upgrade.md)（异步/Long-horizon 模式）

## 背景

当前 `TaskQueue` + `ConcurrencyController` 是纯内存结构，进程重启后所有状态丢失。且所有任务都绑定到用户请求链路，缺少独立的后台执行能力。

参考 Agentara 的任务调度设计，有几个关键洞察：

1. **任务系统是真正的执行入口，消息只是任务的一种来源** — 消息通道和 API 都收敛到同一个 `dispatch()` 边界
2. **入队即持久化** — 任务进入队列同时写入 `tasks` 表为 `pending`，不依赖内存
3. **会话级串行 + 跨会话并发** — 通过 session lock promise 链实现，避免单会话上下文并发污染
4. **调度器不关心执行细节** — 只负责"持久化状态 + 调度 handler + 中断控制"，不知道 Claude/Codex
5. **完整的取消链路** — /stop 命令和消息撤回都能通过 AbortController 中断运行中的任务

## 目标

1. 任务入队即持久化（SQLite），进程重启后可恢复/查询
2. 会话级 FIFO 串行 + 跨会话并发（可配置并发度）
3. 支持同步/异步/Long-horizon 三种执行模式
4. 完整的任务生命周期：pending → running → completed/failed/cancelled
5. 支持任务取消（/stop、消息撤回、AbortController）
6. 调度器与执行逻辑解耦 — 调度器不知道 Claude/Codex/LightLLM

## 非目标

- 不做分布式任务队列
- 不做任务优先级抢占
- 不做任务依赖编排（DAG）
- 不做崩溃后自动恢复执行（只恢复状态查询，不自动重跑）

## 方案

### 1. 核心架构

```
消息通道入口 ─┐
              ├─→ TaskDispatcher.dispatch(sessionId, payload)
API 入口 ────┘         │
                       ├─ 1. tasks 表写入 pending
                       ├─ 2. 加入内存队列
                       └─ 3. Worker 消费
                              │
                    ┌─────────┴─────────┐
                    │   Session Lock     │
                    │ (同 session 串行)  │
                    └─────────┬─────────┘
                              │
                        handler(task)
                    ┌─────────┴─────────┐
                    │ IntelligenceGateway │  ← DD-014
                    │ (分类 → 拦截/下沉)  │
                    └───────────────────┘
```

### 2. Task 持久化 Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- 'chat' | 'scheduled' | 'automation' | 'system' | 'harness'
  execution_mode TEXT NOT NULL,      -- 'sync' | 'async' | 'long-horizon'
  source TEXT NOT NULL,              -- 'user' | 'system' | 'scheduler'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

  -- 内容
  description TEXT,                  -- 人类可读摘要（≤200 chars）
  inbound_message_id TEXT,           -- 原始消息 ID（用于撤回关联）
  claude_session_id TEXT,            -- Claude Code session（用于 resume）

  -- 时间线
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,

  -- 结果
  result_summary TEXT,               -- 完成后摘要（≤1000 chars）
  error_message TEXT,                -- 失败时的错误

  -- 元数据
  metadata TEXT                      -- JSON：classifyResult、channel 等
);

CREATE INDEX idx_tasks_session ON tasks(session_id, created_at);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status, created_at DESC);
CREATE INDEX idx_tasks_active ON tasks(status) WHERE status IN ('pending', 'running');
CREATE INDEX idx_tasks_inbound_msg ON tasks(inbound_message_id) WHERE inbound_message_id IS NOT NULL;
```

### 3. TaskDispatcher

```typescript
// src/kernel/tasking/task-dispatcher.ts

interface TaskPayload {
  type: TaskType;
  message: BotMessage;
  executionMode?: ExecutionMode;    // 可由分类器后续填充
  source: 'user' | 'system' | 'scheduler';
  metadata?: Record<string, unknown>;
}

class TaskDispatcher {
  private sessionLocks: Map<string, Promise<void>> = new Map();
  private runningTasks: Map<string, { task: TaskRecord; abort: AbortController }> = new Map();
  private concurrency: number;
  private running: number = 0;
  private pendingQueue: Array<{ sessionId: string; task: TaskRecord; payload: TaskPayload }> = [];

  constructor(
    private taskStore: TaskStore,
    private handler: (task: TaskRecord, payload: TaskPayload, signal: AbortSignal) => Promise<string>,
    config: { concurrency?: number } = {},
  ) {
    this.concurrency = config.concurrency || 4;
  }

  /**
   * 统一入口：消息通道和 API 都走这里
   */
  async dispatch(sessionId: string, payload: TaskPayload): Promise<string> {
    // 1. 持久化 pending 状态
    const task: TaskRecord = {
      id: generateId(),
      userId: payload.message.userId,
      sessionId,
      type: payload.type,
      executionMode: payload.executionMode || 'sync',
      source: payload.source,
      status: 'pending',
      description: payload.message.content.slice(0, 200),
      inboundMessageId: payload.message.id,
      createdAt: Date.now(),
    };
    this.taskStore.create(task);

    // 2. 加入执行队列
    this.enqueue(sessionId, task, payload);

    return task.id;
  }

  private enqueue(sessionId: string, task: TaskRecord, payload: TaskPayload): void {
    if (this.running < this.concurrency) {
      this.startTask(sessionId, task, payload);
    } else {
      this.pendingQueue.push({ sessionId, task, payload });
    }
  }

  private async startTask(sessionId: string, task: TaskRecord, payload: TaskPayload): Promise<void> {
    this.running++;

    // 会话级串行：接到该 session 的 promise 链后面
    const prevLock = this.sessionLocks.get(sessionId) || Promise.resolve();
    const currentLock = prevLock.then(() => this.executeTask(sessionId, task, payload));
    this.sessionLocks.set(sessionId, currentLock.catch(() => {})); // 不让链断裂

    await currentLock;
  }

  private async executeTask(sessionId: string, task: TaskRecord, payload: TaskPayload): Promise<void> {
    const abort = new AbortController();
    this.runningTasks.set(task.id, { task, abort });

    // 状态 → running
    task.status = 'running';
    task.startedAt = Date.now();
    this.taskStore.updateStatus(task.id, 'running', { startedAt: task.startedAt });

    try {
      const result = await this.handler(task, payload, abort.signal);

      task.status = 'completed';
      task.completedAt = Date.now();
      task.resultSummary = result.slice(0, 1000);
      this.taskStore.updateStatus(task.id, 'completed', {
        completedAt: task.completedAt,
        resultSummary: task.resultSummary,
      });
    } catch (error) {
      task.completedAt = Date.now();
      if (abort.signal.aborted) {
        task.status = 'cancelled';
        this.taskStore.updateStatus(task.id, 'cancelled', { completedAt: task.completedAt });
      } else {
        task.status = 'failed';
        task.errorMessage = error instanceof Error ? error.message : String(error);
        this.taskStore.updateStatus(task.id, 'failed', {
          completedAt: task.completedAt,
          errorMessage: task.errorMessage,
        });
      }
    } finally {
      this.runningTasks.delete(task.id);
      this.running--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (this.running < this.concurrency && this.pendingQueue.length > 0) {
      const { sessionId, task, payload } = this.pendingQueue.shift()!;
      this.startTask(sessionId, task, payload);
    }
  }

  // ── 取消 ──

  /**
   * /stop 命令：取消指定 session 的运行中任务
   */
  cancelBySession(sessionId: string): number {
    let cancelled = 0;

    // 取消运行中的
    for (const [taskId, { task, abort }] of this.runningTasks) {
      if (task.sessionId === sessionId) {
        abort.abort();
        cancelled++;
      }
    }

    // 移除队列中 pending 的
    const before = this.pendingQueue.length;
    this.pendingQueue = this.pendingQueue.filter(item => {
      if (item.sessionId === sessionId) {
        this.taskStore.updateStatus(item.task.id, 'cancelled', { completedAt: Date.now() });
        return false;
      }
      return true;
    });
    cancelled += before - this.pendingQueue.length;

    return cancelled;
  }

  /**
   * 消息撤回：取消关联的 pending/running 任务
   */
  cancelByMessageId(inboundMessageId: string): boolean {
    // 查 pending queue
    const idx = this.pendingQueue.findIndex(
      item => item.task.inboundMessageId === inboundMessageId
    );
    if (idx >= 0) {
      const { task } = this.pendingQueue.splice(idx, 1)[0];
      this.taskStore.updateStatus(task.id, 'cancelled', { completedAt: Date.now() });
      return true;
    }

    // 查 running tasks
    for (const [taskId, { task, abort }] of this.runningTasks) {
      if (task.inboundMessageId === inboundMessageId) {
        abort.abort();
        return true;
      }
    }

    return false;
  }

  // ── 查询 ──

  getActiveTasks(sessionId?: string): TaskRecord[] {
    if (sessionId) {
      return [...this.runningTasks.values()]
        .filter(({ task }) => task.sessionId === sessionId)
        .map(({ task }) => task);
    }
    return [...this.runningTasks.values()].map(({ task }) => task);
  }

  // ── 生命周期 ──

  async shutdown(): Promise<void> {
    // 取消所有运行中任务
    for (const [, { abort }] of this.runningTasks) {
      abort.abort();
    }
    // 标记所有 pending 为 cancelled
    for (const { task } of this.pendingQueue) {
      this.taskStore.updateStatus(task.id, 'cancelled', {
        completedAt: Date.now(),
        errorMessage: 'process_shutdown',
      });
    }
    this.pendingQueue = [];

    // 等待运行中任务完成（最多 10s）
    const deadline = Date.now() + 10_000;
    while (this.runningTasks.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
```

### 4. TaskStore

```typescript
// src/kernel/tasking/task-store.ts

class TaskStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(task: TaskRecord): void {
    this.db.prepare(`
      INSERT INTO tasks (id, user_id, session_id, type, execution_mode, source,
                         status, description, inbound_message_id, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      task.id, task.userId, task.sessionId, task.type, task.executionMode,
      task.source, task.description, task.inboundMessageId,
      task.createdAt, JSON.stringify(task.metadata || {}),
    );
  }

  updateStatus(taskId: string, status: string, fields: Partial<TaskRecord>): void {
    const sets = ['status = ?'];
    const values: unknown[] = [status];

    if (fields.startedAt) { sets.push('started_at = ?'); values.push(fields.startedAt); }
    if (fields.completedAt) { sets.push('completed_at = ?'); values.push(fields.completedAt); }
    if (fields.resultSummary) { sets.push('result_summary = ?'); values.push(fields.resultSummary); }
    if (fields.errorMessage) { sets.push('error_message = ?'); values.push(fields.errorMessage); }
    if (fields.claudeSessionId) { sets.push('claude_session_id = ?'); values.push(fields.claudeSessionId); }

    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getHistory(userId: string, limit = 20): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND execution_mode != 'sync'
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit) as TaskRecord[];
  }

  getActiveBySession(sessionId: string): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE session_id = ? AND status IN ('pending', 'running')
      ORDER BY created_at
    `).all(sessionId) as TaskRecord[];
  }

  findByMessageId(messageId: string): TaskRecord | undefined {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE inbound_message_id = ? AND status IN ('pending', 'running')
    `).get(messageId) as TaskRecord | undefined;
  }

  // 进程启动时：标记所有 running 为 interrupted
  markInterruptedOnStartup(): number {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'failed', error_message = 'process_restart',
                       completed_at = ?
      WHERE status = 'running'
    `).run(Date.now());
    return result.changes;
  }

  // 清理历史（保留 30 天）
  cleanupOld(daysToKeep = 30): number {
    const cutoff = Date.now() - daysToKeep * 86400_000;
    const result = this.db.prepare(`
      DELETE FROM tasks WHERE completed_at < ? AND status NOT IN ('pending', 'running')
    `).run(cutoff);
    return result.changes;
  }
}
```

### 5. 进程启动恢复

```typescript
async function onProcessStart(taskStore: TaskStore, sessionStore: SessionStore) {
  // 1. 标记所有 running 任务为中断
  const interrupted = taskStore.markInterruptedOnStartup();
  if (interrupted > 0) {
    logger.warn(`Marked ${interrupted} running tasks as interrupted on startup`);
  }

  // 2. 检查是否有需要 resume 的 long-horizon session（见下方 resume 设计）
  const activeSessions = sessionStore.getActiveLongHorizonSessions();
  for (const session of activeSessions) {
    // 不自动恢复，等用户下次发消息时提示
    sessionStore.markForResume(session.id);
  }
}
```

### 6. 与 CentralController 的集成

```typescript
class CentralController {
  private dispatcher: TaskDispatcher;

  constructor(deps) {
    this.dispatcher = new TaskDispatcher(
      deps.taskStore,
      // handler：不感知 Claude/Codex，只调用 IntelligenceGateway
      async (task, payload, signal) => {
        return this.gateway.handle({ ...task, ...payload, signal });
      },
      { concurrency: 4 },
    );
  }

  // 消息入口
  async handleIncomingMessage(message: BotMessage): Promise<void> {
    const session = await this.sessionManager.resolveSession(message);
    await this.dispatcher.dispatch(session.id, {
      type: 'chat',
      message,
      source: 'user',
    });
  }

  // /stop 命令
  async handleStop(sessionId: string): Promise<void> {
    const cancelled = this.dispatcher.cancelBySession(sessionId);
    // 通知用户
  }

  // 消息撤回
  async handleMessageRecall(messageId: string): Promise<void> {
    this.dispatcher.cancelByMessageId(messageId);
  }

  // API 入口（和消息通道走同一个 dispatch）
  async handleApiTask(payload: TaskPayload, sessionId: string): Promise<string> {
    return this.dispatcher.dispatch(sessionId, payload);
  }
}
```

### 7. MCP Tool

```typescript
const tasksTool = {
  name: 'task_history',
  description: '查询任务执行历史和状态',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['active', 'history', 'cancel'],
      },
      taskId: { type: 'string', description: 'cancel 时必填' },
      limit: { type: 'number', description: '历史查询条数，默认 10' },
    },
    required: ['operation'],
  },
  handler: async (args, context) => {
    switch (args.operation) {
      case 'active':
        return { tasks: dispatcher.getActiveTasks() };
      case 'history':
        return { tasks: taskStore.getHistory(context.userId, args.limit || 10) };
      case 'cancel':
        if (!args.taskId) return { error: 'taskId required' };
        // 通过 dispatcher 取消
        return { success: true };
    }
  },
};
```

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/tasking/task-dispatcher.ts` | 新增 — 替代当前 TaskQueue |
| `src/kernel/tasking/task-store.ts` | 新增 — SQLite 持久化 |
| `src/kernel/tasking/task-queue.ts` | 废弃 — 由 TaskDispatcher 接管 |
| `src/kernel/tasking/concurrency-controller.ts` | 废弃 — 由 TaskDispatcher 内置 |
| `src/kernel/central-controller.ts` | 重构 — 使用 TaskDispatcher |
| `infra/database/migrations/` | 新增 — tasks 表 |
| `mcp-servers/memory/index.ts` | 扩展 — task_history tool |

## 验收标准

- [ ] 任务入队即写入 SQLite（pending 状态）
- [ ] 同 session 任务 FIFO 串行执行
- [ ] 跨 session 任务并发执行（≤ concurrency 上限）
- [ ] /stop 能取消 running 任务和清空 pending 队列
- [ ] 消息撤回能取消对应的 pending/running 任务
- [ ] 进程重启后 running 任务标记为 interrupted
- [ ] task_history MCP tool 可查询活跃和历史任务
- [ ] `bun run check:all` 通过

## 参考

- Agentara `TaskDispatcher` — 入队即持久化、session lock 串行、AbortController 取消
- hermes-agent `gateway/run.py` — `/background` 后台任务
- Node.js AbortController — 标准取消机制
- [DD-016](016-session-history-persistence.md) — 共用 SQLite 实例
