# 第7章 定时任务系统

> **本章目标**：介绍定时任务系统的使用方法、支持的语法、生命周期管理和持久化机制。

## 7.1 快速开始

### 用自然语言创建定时任务

直接向 AI 助手发送包含时间描述的消息即可自动创建定时任务：

```
每天上午9点提醒我查看邮件
```

系统会自动：
1. 识别为定时任务意图
2. 将自然语言转换为 Cron 表达式（`0 9 * * *`）
3. 注册 Job 并持久化
4. 在触发时间，AI 根据你的描述生成回复内容
5. 通过你发送消息的通道（飞书/Telegram/Web）推送给你

### 返回示例

```json
{
  "type": "scheduled_registered",
  "jobId": "job_m1a2b3c_x7y8z9",
  "cronExpression": "0 9 * * *",
  "cronDescription": "每天 09:00",
  "confidence": 0.9
}
```

## 7.2 支持的自然语言格式

### 中文

| 自然语言 | 转换结果 | 说明 |
|----------|---------|------|
| `每隔15分钟` | `*/15 * * * *` | 间隔执行 |
| `每半小时` | `*/30 * * * *` | 半小时一次 |
| `每隔2小时` | `0 */2 * * *` | 整点间隔 |
| `每天上午9点` | `0 9 * * *` | 每日定时 |
| `每天下午3点` | `0 15 * * *` | 下午 = +12 |
| `每天晚上8点30` | `0 20 * * *` | 晚上 = +12 |
| `每日早上8点30` | `30 8 * * *` | 带分钟 |
| `每周一上午10点` | `0 10 * * 1` | 指定星期几 |
| `每周五下午5点` | `0 17 * * 5` | 周五 |
| `工作日早上9点` | `0 9 * * 1-5` | 周一到周五 |
| `每月1号` | `0 0 1 * *` | 每月指定日期 |
| `每月15号上午10点` | `0 10 15 * *` | 带时间 |
| `每月第一天` | `0 0 1 * *` | 自然表述 |

### 英文

| Natural Language | Cron | Note |
|-----------------|------|------|
| `every 15 minutes` | `*/15 * * * *` | Interval |
| `every half hour` | `*/30 * * * *` | Half-hourly |
| `every 2 hours` | `0 */2 * * *` | Hourly interval |
| `every day at 9:00` | `0 9 * * *` | Daily at time |
| `daily at 14:30` | `30 14 * * *` | Daily shorthand |
| `every Monday at 10:00` | `0 10 * * 1` | Weekly |
| `weekdays at 9:00` | `0 9 * * 1-5` | Mon-Fri |

### 触发识别的关键词

系统通过以下模式将消息识别为定时任务（`scheduled` 类型）：

- 中文：`每天`、`每日`、`每周`、`每月`、`定时`、`提醒我`
- 英文：`remind`、`schedule`、`every day/week/month/hour/minute`、`at HH:MM`、`cron`

## 7.3 Cron 表达式语法

支持标准 5 位 Cron 表达式，可直接使用：

```
┌──────────── 分钟 (0-59)
│ ┌────────── 小时 (0-23)
│ │ ┌──────── 日 (1-31)
│ │ │ ┌────── 月 (1-12)
│ │ │ │ ┌──── 周几 (0-7, 0 和 7 均为周日)
* * * * *
```

**支持的语法元素：**

| 符号 | 含义 | 示例 |
|------|------|------|
| `*` | 任意值 | `* * * * *`（每分钟） |
| `,` | 列表 | `0 9,18 * * *`（9点和18点） |
| `-` | 范围 | `0 9 * * 1-5`（周一到周五） |
| `/` | 步长 | `*/15 * * * *`（每15分钟） |

**常用表达式速查：**

```
0 9 * * *       每天 09:00
0 9 * * 1-5     工作日 09:00
*/30 * * * *    每 30 分钟
0 */2 * * *     每 2 小时
0 0 1 * *       每月 1 号 00:00
0 9 * * 1       每周一 09:00
0 9,18 * * *    每天 09:00 和 18:00
```

## 7.4 调度架构

### 三引擎协同模型

```
kernel/
├── central-controller.ts   ← 编排枢纽（接收定时请求 + 触发执行）
├── scheduling/             ← 时间引擎（Cron 解析 + Job 注册 + 触发回调）
│   ├── scheduler.ts        ← 核心调度器（定时器管理 + 生命周期）
│   ├── job-store.ts        ← Job 持久化（JSON 文件存储）
│   ├── cron-parser.ts      ← Cron 表达式解析与验证
│   └── nl-to-cron.ts       ← 自然语言 → Cron 转换
└── tasking/                ← 执行引擎（队列 + 并发 + 重试）
```

| 层面 | Scheduling | Tasking |
|------|-----------|---------|
| 职责 | "什么时候执行" | "怎么执行" |
| 核心抽象 | Cron 表达式 + 定时器 | 队列 + 并发控制 + 重试 |
| 状态 | Job 注册表 + 持久化 | Task 生命周期 |
| 触发方 | Cron 定时 / 用户注册 | 人工提交 / 调度触发 |

### Scheduler 生命周期

```
Gateway 启动
  │
  ▼
CentralController.initScheduler()
  ├── JobStore.load()           ← 从 data/scheduler/jobs.json 恢复 jobs
  ├── scheduler.setExecutor()   ← 注入执行回调（chat pipeline + 通道推送）
  └── scheduler.start()         ← 启动定时器
  │
  │   ... 运行中 ...
  │
Gateway 关闭（SIGINT / SIGTERM）
  │
  ▼
CentralController.stopScheduler()
  ├── scheduler.stop()          ← 清除所有定时器
  └── scheduler.persistJobs()   ← 最终持久化
```

## 7.5 Job 生命周期

### 状态转换

```
          register()
              │
              ▼
          ┌────────┐
          │ active │ ◄──── resume()
          └───┬────┘
              │
      ┌───────┼────────┐
      │       │        │
  pause()  cancel()  触发执行
      │       │        │
      ▼       ▼        ▼
  ┌────────┐ ┌─────────┐  executeJob()
  │ paused │ │cancelled│  → 执行后仍为 active
  └────────┘ └─────────┘  → 自动计算下次触发时间
                           → 重新调度
```

- **active**：正常运行，到达触发时间会执行
- **paused**：暂停，不会触发，可 resume 恢复
- **cancelled**：永久取消，从持久化中移除

### 完整执行流程

```
用户: "每天上午9点提醒我查看邮件"
  │
  ▼
[Gateway] → 标准化 BotMessage（记录 channel = feishu/telegram/web）
  │
  ▼
[CentralController.classifyIntent()] → 'scheduled'
  │
  ▼
[CentralController.handleScheduledTask()]
  ├── nlToCron("每天上午9点提醒我查看邮件") → { cron: "0 9 * * *" }
  └── scheduler.register({ cron, channel, userId, taskTemplate })
      └── JobStore.save() → 持久化到磁盘
  │
  │   返回确认: jobId + cronDescription
  │
  │   ... 等待触发时间（每天 09:00）...
  │
  ▼
[Scheduler.executeJob()] → executor 回调
  │
  ▼
[CentralController executor]
  ├── 构造 BotMessage（content = 原始描述, metadata.isScheduledExecution = true）
  ├── sessionManager.resolveSession()
  ├── 确保 workspace + userConfigLoader 初始化
  ├── executeChatPipeline() → AI 根据描述生成提醒内容
  └── channel.sendMessage(userId, { type: 'text', text: AI回复 })
  │
  ▼
用户收到推送: "早上好！该查看邮件了..."
```

## 7.6 持久化

### JobStore

Job 数据通过 `JobStore` 持久化到本地 JSON 文件，确保进程重启后任务不丢失。

- **默认路径**：`data/scheduler/jobs.json`
- **自定义**：通过环境变量 `SCHEDULER_STORE_PATH` 覆盖
- **目录自动创建**：首次写入时自动创建 `data/scheduler/` 目录

### 持久化时机

以下操作完成后自动写入磁盘：

| 操作 | 说明 |
|------|------|
| `register()` | 注册新 job |
| `pause()` | 暂停 job |
| `resume()` | 恢复 job |
| `cancel()` | 取消 job（写入时过滤掉） |
| `executeJob()` | 执行后更新 executionCount / lastResult |
| `stopScheduler()` | 进程关闭前最终持久化 |

### 存储格式

```json
[
  {
    "id": "job_m1a2b3c_x7y8z9",
    "cronExpression": "0 9 * * *",
    "taskTemplate": {
      "messageContent": "每天上午9点提醒我查看邮件",
      "userName": "张三",
      "conversationId": "conv_abc"
    },
    "userId": "user_001",
    "description": "每天上午9点提醒我查看邮件",
    "channel": "feishu",
    "status": "active",
    "nextRunAt": 1741327200000,
    "createdAt": 1741240800000,
    "executionCount": 3,
    "lastRunAt": 1741240800000,
    "lastResult": { "success": true, "taskId": "task_xxx", "completedAt": 1741240801000 }
  }
]
```

> **注意**：`cancelled` 状态的 job 在持久化时会被自动过滤，不会写入文件。

## 7.7 通道绑定

注册定时任务时，系统会记录用户发送消息的通道（`channel`），触发执行时通过相同通道推送结果：

| 注册通道 | 触发时推送到 |
|---------|------------|
| 飞书 | 飞书消息 |
| Telegram | Telegram 消息 |
| Web (WebSocket) | WebSocket 推送 |
| API | 不推送（仅记录结果） |

如果用户在飞书中说"每天提醒我..."，到时间后会在飞书中收到提醒。

## 7.8 Task Queue 与并发控制

定时任务触发后，通过 Task Queue 执行，受三级并发控制约束：

```typescript
export class ConcurrencyController {
  private readonly globalSlots: number = 25;   // 全局最大 25 并发
  private readonly perUserSlots: number = 3;    // 每用户最大 3 并发
}
```

重试策略采用指数退避：

| 重试次数 | 延迟 | 计算公式 |
|---------|------|---------|
| 第 1 次 | 5s | base × 2⁰ |
| 第 2 次 | 10s | base × 2¹ |
| 第 3 次 | 20s | base × 2² |

## 7.9 使用示例

### 示例 1：每日提醒

```
用户: 每天早上8点30提醒我站会
```

→ Cron: `30 8 * * *`，每天 08:30 AI 生成提醒并推送。

### 示例 2：工作日定时汇报

```
用户: 工作日下午6点帮我总结今天的工作
```

→ Cron: `0 18 * * 1-5`，周一至周五 18:00 触发。

### 示例 3：周期检查

```
用户: every 2 hours check the server status
```

→ Cron: `0 */2 * * *`，每 2 小时整点触发。

### 示例 4：月度任务

```
用户: 每月1号提醒我交房租
```

→ Cron: `0 0 1 * *`，每月 1 日 00:00 触发。

### 示例 5：直接使用 Cron

```
用户: cron 0 9,18 * * 1-5 提醒我喝水
```

→ 直接使用提供的 Cron 表达式（如果消息包含 `cron` 关键词，系统会尝试解析）。

---
