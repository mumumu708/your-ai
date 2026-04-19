# DD-013: 任务调度细化

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-11
- **上游**: [DD-011](011-architecture-upgrade-v2.md)

## 背景

当前 `TaskQueue` + `ConcurrencyController` 只支持一种执行模型：用户发消息 → 排队 → 串行处理 → 回复。Scheduler 的定时任务本质上是"模拟一条用户消息"。

三个缺失：
1. **异步后台任务**：信息摄入、批量消化、后台反思（DD-012）需要不绑定用户请求的执行能力
2. **Long-horizon 任务**：Deep Research、复杂代码生成需要长时间运行 + 流式反馈 + 中间可干预
3. **任务聚合**：用户在任务执行期间连续发送多条消息，queue 中积压的消息需要预处理

## 目标

1. 支持三种执行模式：同步、异步、Long-horizon
2. 任务聚合：执行下一个任务前，对 queue 中积压消息做智能合并
3. 异步任务完成后通过用户活跃通道推送通知
4. Long-horizon 任务支持流式反馈和中间干预

## 非目标

- 不做分布式任务队列（单进程内存队列足够）
- 不做任务优先级抢占（FIFO 足够）
- 不做跨用户任务编排

## 方案

### 1. 三种执行模式

```typescript
type ExecutionMode = 'sync' | 'async' | 'long-horizon';

interface WorkUnit {
  id: string;
  userId: string;
  source: 'user' | 'system' | 'scheduler';  // 谁触发的
  mode: ExecutionMode;
  message: BotMessage;                        // 原始或聚合后的消息
  session: Session;
  classifyResult: UnifiedClassifyResult;
  createdAt: number;
  signal?: AbortSignal;                       // Long-horizon 可取消
  metadata: Record<string, unknown>;
}
```

#### 模式特征

| 维度 | 同步 | 异步 | Long-horizon |
|------|------|------|-------------|
| 时长 | 秒级（<30s） | 分钟级 | 分钟~小时 |
| 用户感知 | 等待回复 | 收到"已开始"确认 | 持续流式更新 |
| 结果推送 | 直接回复 | 完成后通知 | 流式 + 最终结果 |
| 可干预 | 否 | 可取消 | 可追加指令/取消 |
| Claude Code 配置 | 精简 tools | 完整 tools | 完整 tools + 文件系统 |
| 典型场景 | 简单问答 | 后台反思、信息摄入 | Deep Research、代码重构 |

#### 分类器扩展

```typescript
interface UnifiedClassifyResult {
  taskType: 'chat' | 'scheduled' | 'automation' | 'system' | 'harness';
  complexity: 'simple' | 'complex';
  executionMode: ExecutionMode;  // 新增
  // ...existing fields
}
```

执行模式判定规则：

```
1. taskType === 'harness' → long-horizon
2. taskType === 'scheduled' && source === 'scheduler' → async
3. 用户显式要求后台执行（"帮我后台处理"） → async
4. 系统内部触发（反思、摄入） → async
5. classifyResult.complexity === 'simple' → sync
6. 其他 → sync（默认，除非检测到 long-horizon 特征）
```

Long-horizon 特征检测（启发式）：
- 包含"深度研究"、"全面分析"、"写一份报告"等关键词
- 任务涉及多步骤、多文件操作
- 预估需要多轮 tool 调用

### 2. 任务聚合

#### 场景

Session 内任务串行执行。Task A 执行期间用户发了 3 条消息：

```
Queue: ["123", "你在么", "我需要查询明天的天气"]
```

Task A 完成后，执行下一个任务前，需要对 queue 做聚合。

#### 聚合策略（规则层 + LLM 兜底）

```
Step 1: 规则层快速过滤
├─ 纯数字/符号/表情（"123"、"666"、"👍"） → noise
├─ 问候/确认类（"在吗"、"你好"、"嗯"） → greeting
├─ 与前一条时间间隔 < 3s 且无独立语义 → continuation
└─ 输出：filtered[] + meaningful[]

Step 2: 有意义消息处理
├─ 只有 1 条 → 直接作为下一个任务
├─ 多条且明显覆盖关系 → 保留最后一条
│   （例如"查北京天气" → "查上海天气"，后者覆盖前者）
├─ 多条且独立意图 → 保留为多个独立任务
└─ 多条且语义相关但不确定 → 调 LLM 判断

Step 3: LLM 聚合（仅在 Step 2 不确定时调用）
├─ 输入：pending 消息列表 + 最近的对话上下文
├─ 输出：{ mergedMessage: string, reason: string }
└─ 调用 Claude Code（短 prompt，低成本）
```

#### 实现位置

在 `CentralController` 的任务执行循环中，`TaskQueue.dequeue()` 之后、`execute()` 之前插入聚合步骤：

```typescript
class CentralController {
  private async processNextTask(sessionKey: string) {
    // 聚合 queue 中的 pending 消息
    const pendingMessages = this.taskQueue.drainPending(sessionKey);

    if (pendingMessages.length === 0) return;
    if (pendingMessages.length === 1) {
      return this.executeTask(pendingMessages[0]);
    }

    // 聚合
    const aggregated = await this.queueAggregator.aggregate(
      pendingMessages,
      this.getRecentContext(sessionKey)
    );

    for (const task of aggregated) {
      await this.executeTask(task);
    }
  }
}
```

#### 聚合结果处理

| 聚合结果 | 处理方式 |
|---------|---------|
| 全部是 noise | 不执行任何任务 |
| noise + 1 条有意义 | 执行有意义的那条 |
| N 条合并为 1 条 | 执行合并后的消息 |
| N 条保持独立 | 按序依次执行 |

如果有 noise 消息被过滤，可选择发送一条轻量确认（"收到你之前的消息，正在处理最新的请求"）。

### 3. 异步任务执行

```typescript
class AsyncExecutor {
  async submit(workUnit: WorkUnit): Promise<string> {  // 返回 taskId
    // 1. 立即回复确认
    await this.notifyUser(workUnit.userId, workUnit.session.channel,
      `已开始后台处理：${workUnit.message.content.slice(0, 50)}...`
    );

    // 2. 后台执行
    this.runInBackground(workUnit).then(result => {
      // 3. 完成后推送
      this.notifyUser(workUnit.userId, workUnit.session.channel,
        this.formatResult(result)
      );
    }).catch(error => {
      this.notifyUser(workUnit.userId, workUnit.session.channel,
        `后台任务失败：${error.message}`
      );
    });

    return workUnit.id;
  }

  private async runInBackground(workUnit: WorkUnit) {
    // 独立的 Claude Code session
    // 不占用用户的前台 session
    return this.agentBridge.execute({
      systemPrompt: workUnit.session.frozenSystemPrompt,
      userMessage: workUnit.message.content,
      tools: this.getToolsForMode('async'),
      // 无流式回调
    });
  }
}
```

### 4. Long-horizon 任务执行

```typescript
class LongHorizonExecutor {
  async execute(workUnit: WorkUnit): Promise<TaskResult> {
    const streamAdapter = this.getStreamAdapter(workUnit.session.channel);

    // 初始化流式反馈
    await streamAdapter.sendToken('开始深度处理...\n');

    return this.agentBridge.execute({
      systemPrompt: workUnit.session.frozenSystemPrompt,
      userMessage: workUnit.message.content,
      tools: this.getToolsForMode('long-horizon'),
      signal: workUnit.signal,  // 支持取消
      streamCallback: async (event) => {
        // 流式推送到通道
        await streamAdapter.sendToken(event.content);
      },
    });
  }

  // 中间干预：用户在 long-horizon 执行期间发新消息
  async handleIntervention(sessionKey: string, message: BotMessage) {
    // 将用户的新消息作为追加指令注入到正在执行的 Claude Code session
    // Claude Code 的 session 机制原生支持这个
    await this.agentBridge.appendMessage(sessionKey, message.content);
  }
}
```

### 5. WorkDispatcher 架构

```
CentralController.handleIncomingMessage()
    │
    ├─ classifyIntent() → { taskType, complexity, executionMode }
    │
    ├─ TaskQueue.enqueue()（如果 session 有正在执行的任务）
    │   └─ 用户消息入队等待
    │
    └─ WorkDispatcher.dispatch(workUnit)
        │
        ├─ executionMode === 'sync'
        │   └─ SyncExecutor.execute()
        │       → 直接在当前 session 执行并回复
        │
        ├─ executionMode === 'async'
        │   └─ AsyncExecutor.submit()
        │       → 立即确认 + 后台执行 + 完成通知
        │
        └─ executionMode === 'long-horizon'
            └─ LongHorizonExecutor.execute()
                → 流式反馈 + 可干预 + 最终结果
```

### 6. Long-horizon Session Resume

Long-horizon 任务可能运行几十分钟甚至数小时。如果 your-ai 进程在此期间重启，任务进度全部丢失。需要 resume 机制。

#### 设计原则

- **只有 long-horizon 任务需要 resume** — 同步和普通异步任务不需要
- **不自动恢复执行** — 进程重启后标记为 interrupted，等用户确认后再恢复
- **通过 Claude Code 的 `--resume` 机制** — Claude Code 原生支持 session 恢复

#### 持久化

DD-017 的 tasks 表已有 `claude_session_id` 字段。Long-horizon 任务开始时：

```typescript
// Long-horizon 执行器
async execute(task: Task, signal: AbortSignal): Promise<string> {
  const result = await this.agentBridge.execute({
    ...params,
    streamCallback: (event) => streamAdapter.sendToken(event),
    signal,
  });

  // 持久化 Claude session ID（用于 resume）
  if (result.claudeSessionId) {
    this.taskStore.updateStatus(task.id, task.status, {
      claudeSessionId: result.claudeSessionId,
    });
  }

  return result.content;
}
```

#### 恢复流程

```
进程重启
    │
    ├─ DD-017: taskStore.markInterruptedOnStartup()
    │   → 所有 running 任务标记为 failed/process_restart
    │
    ├─ 检查 long-horizon 中断任务
    │   → SELECT * FROM tasks
    │     WHERE execution_mode = 'long-horizon'
    │       AND status = 'failed'
    │       AND error_message = 'process_restart'
    │       AND claude_session_id IS NOT NULL
    │
    └─ 用户下次发消息时提示
        │
        ├─ "检测到未完成的长程任务：{description}"
        ├─ "是否继续？（将从上次中断处恢复）"
        │
        └─ 用户确认后：
            ├─ agentBridge.execute({
            │     claudeSessionId: task.claude_session_id,
            │     // --resume 模式
            │   })
            └─ 新建 task 记录关联到原 session
```

#### 提示时机

不在进程启动时立即推送通知（用户可能不在线），而是**等用户下次发消息时**检查并提示：

```typescript
class CentralController {
  async handleIncomingMessage(message: BotMessage) {
    // 检查是否有可恢复的 long-horizon 任务
    const resumable = this.taskStore.getResumableTasks(message.userId);
    if (resumable.length > 0) {
      const task = resumable[0]; // 最近的一个
      await this.sendToChannel(session.channel, message.userId,
        `⚠️ 检测到上次未完成的长程任务：${task.description}\n` +
        `回复"继续"恢复，或"取消"放弃。`
      );
      // 等待用户回复...
      return;
    }

    // 正常处理
    // ...
  }
}
```

#### 不做 resume 的场景

| 场景 | 处理 |
|------|------|
| 同步任务中断 | 不恢复，丢失可接受 |
| 异步后台任务中断 | 不恢复，大多数可重新触发（反思、摄入） |
| Scheduler 任务中断 | 不恢复，下次定时触发时重新执行 |
| Long-horizon 但无 claudeSessionId | 不恢复，标记为失败 |
| Long-horizon 中断超过 24 小时 | 不恢复，Claude session 可能已过期 |

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/shared/tasking/task.types.ts` | 扩展 — `ExecutionMode`、`WorkUnit` 类型 |
| `src/kernel/tasking/task-queue.ts` | 扩展 — `drainPending()` 方法 |
| `src/kernel/tasking/queue-aggregator.ts` | 新增 — 消息聚合逻辑 |
| `src/kernel/tasking/work-dispatcher.ts` | 新增 — 三模式分发 |
| `src/kernel/tasking/async-executor.ts` | 新增 — 异步任务执行 |
| `src/kernel/tasking/long-horizon-executor.ts` | 新增 — Long-horizon 执行 |
| `src/kernel/classifier/task-classifier.ts` | 扩展 — 执行模式判定 |
| `src/kernel/central-controller.ts` | 重构 — 集成 WorkDispatcher |

## 备选方案

### 聚合全交给 LLM

每次都调 LLM 判断 queue 中消息的关系。

问题：
- token 浪费（大多数情况规则就能处理）
- 延迟增加（多一次 LLM 调用）

**决策**：规则层快速过滤 + LLM 兜底。

### Long-horizon 用独立进程

spawn 完全独立的 Node/Bun 进程执行。

问题：
- 进程间通信复杂
- Session 状态共享困难
- 资源管理开销

**决策**：在同一进程内用异步执行，通过 AbortSignal 管理生命周期。

## 验收标准

- [ ] 三种执行模式可正确分类和分发
- [ ] 任务聚合能过滤噪声消息、合并相关消息
- [ ] 异步任务完成后能推送通知到用户通道
- [ ] Long-horizon 任务支持流式反馈
- [ ] Long-horizon 任务支持用户中途取消
- [ ] Long-horizon 中断后可通过 Claude Code --resume 恢复
- [ ] 进程重启后用户下次发消息时提示可恢复任务
- [ ] 不影响现有同步任务的正确性和延迟
- [ ] `bun run check:all` 通过

## 参考

- hermes-agent `gateway/run.py` — `/background` 和 `/btw` 后台任务
- Long-horizon Agent 概念 — Harrison Chase / LangChain
- Claude Code subagent 机制 — 独立 context 的子任务执行
