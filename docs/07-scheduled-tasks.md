# 第7章 定时任务系统
> **本章目标**：设计基于 Kernel 层三引擎协同模型（Scheduling + Tasking + CentralController）的定时任务系统。
## 7.1 调度架构
### 7.1.1 TELGENT 三引擎协同模型
```plaintext
kernel/
├── central-controller.ts   ← 编排枢纽（接收定时请求 + 触发执行）
├── scheduling/             ← 时间引擎（Cron 解析 + Job 注册 + 触发回调）
└── tasking/                ← 执行引擎（队列 + 并发 + 重试）


```

### 7.1.2 为何拆分 Scheduling 和 Tasking


| 层面 | Scheduling | Tasking |
| --- | --- | --- |
| 职责 | “什么时候执行” | “怎么执行” |
| 核心抽象 | Cron 表达式 + 时间轮 | 队列 + 并发控制 + 重试 |
| 状态 | Job 注册表 | Task 生命周期 |
| 触发方 | Cron 定时 / Interval 周期 | 人工提交 / 调度触发 |


## 7.2 Scheduler 引擎
```typescript
// src/kernel/scheduling/scheduler.ts
export class Scheduler {
  private readonly jobs: Map<string, ScheduledJob> = new Map();
  private readonly timers: Map<string, Timer> = new Map();
  private running = false;

  async register(config: ScheduleConfig): Promise<string> {
    const jobId = `job_${nanoid()}`;
    const job: ScheduledJob = {
      id: jobId,
      cronExpression: config.cronExpression,
      taskTemplate: config.taskTemplate,
      userId: config.userId,
      description: config.description,
      status: 'active',
      nextRunAt: this.calculateNextRun(config.cronExpression),
      createdAt: Date.now(),
      executionCount: 0,
      lastResult: null,
    };
    this.jobs.set(jobId, job);
    this.scheduleNextRun(job);
    await this.persist();
    return jobId;
  }

  private scheduleNextRun(job: ScheduledJob): void {
    const delay = job.nextRunAt - Date.now();
    if (delay <= 0) { this.executeJob(job); return; }
    const timer = setTimeout(() => this.executeJob(job), delay);
    this.timers.set(job.id, timer);
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    job.executionCount++;
    job.lastRunAt = Date.now();
    // 回到 CentralController 统一编排
    const controller = CentralController.getInstance();
    const task = this.buildTaskFromTemplate(job);
    const result = await controller.orchestrate(task);
    job.lastResult = result;
    // 计算下次执行时间
    job.nextRunAt = this.calculateNextRun(job.cronExpression);
    this.scheduleNextRun(job);
  }
}


```

### 7.2.1 Cron 表达式解析
支持标准 5 位 Cron 表达式：
```plaintext
┌──────────── 分钟 (0-59)
│ ┌────────── 小时 (0-23)
│ │ ┌──────── 日 (1-31)
│ │ │ ┌────── 月 (1-12)
│ │ │ │ ┌──── 周几 (0-7)
* * * * *


```

示例：
- `0 9 * * 1-5` → 工作日每天上午 9 点
- `*/30 * * * *` → 每 30 分钟
- `0 0 1 * *` → 每月 1 日凌晨
## 7.3 Task Queue
基于 Bunqueue 的任务队列，提供三级并发控制：
```typescript
export class ConcurrencyController {
  private readonly globalSlots: number = 25;   // 全局最大 25 并发
  private readonly perUserSlots: number = 3;    // 每用户最大 3 并发
  private activeGlobal = 0;
  private activePerUser: Map<string, number> = new Map();

  async acquire(userId: string): Promise<void> {
    while (this.activeGlobal >= this.globalSlots ||
           (this.activePerUser.get(userId) ?? 0) >= this.perUserSlots) {
      await Bun.sleep(100);
    }
    this.activeGlobal++;
    this.activePerUser.set(userId, (this.activePerUser.get(userId) ?? 0) + 1);
  }
}
```

重试策略采用指数退避：


| 重试次数 | 延迟 | 计算公式 |
| --- | --- | --- |
| 第 1 次 | 5s | base * 2^0 |
| 第 2 次 | 10s | base * 2^1 |
| 第 3 次 | 20s | base * 2^2 |


## 7.4 自然语言到 Cron 的转换
用户可以用自然语言描述定时任务，系统自动转换为 Cron 表达式：


| 自然语言 | Cron 表达式 |
| --- | --- |
| “每天上午9点” | `0 9 * * *` |
| “每周一上午10点” | `0 10 * * 1` |
| “每隔半小时” | `*/30 * * * *` |
| “工作日晚上6点” | `0 18 * * 1-5` |
| “每月第一天” | `0 0 1 * *` |


## 7.5 定时任务完整生命周期
```plaintext
用户: "每天上午9点提醒我查看邮件"
  │
  ▼
[Gateway] → 标准化 BotMessage
  │
  ▼
[CentralController.classifyIntent()] → 'scheduled'
  │
  ▼
[CentralController.handleScheduledTask()]
  │
  ▼
[Scheduler.register({ cron: '0 9 * * *', ... })]
  │
  │   ... 等待触发时间 ...
  │
  ▼
[Scheduler.executeJob()] → 构造 Task
  │
  ▼
[CentralController.orchestrate(task)] → ChatTask
  │
  ▼
[AgentRuntime.execute()] → AI 生成提醒内容
  │
  ▼
[Gateway] → 推送给用户
```

---
