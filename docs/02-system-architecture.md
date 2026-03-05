# 第2章 系统架构设计
> 本章全面阐述 YourBot AI 助手平台的系统架构设计。架构参考 TELGENT 项目的分层治理思想，将系统从传统的四层模型重构为**五层架构**——接入层（Gateway）、内核层（Kernel）、共享层（Shared）、用户空间层（User Space）和基础设施层（Infrastructure）。
---

## 2.1 架构总览：五层分治模型
### 2.1.1 设计哲学
传统 Bot 平台常采用扁平化的"路由→处理→响应"模式，随着功能膨胀不可避免地走向巨石架构。TELGENT 项目提出的分层思想给了我们关键启示：**将关注点按职责域垂直切分为独立层级，每一层只关心自己的边界问题，通过明确定义的接口与上下层通信**。YourBot 的五层架构遵循以下原则：
- **单向依赖**：上层可依赖下层，下层绝不反向依赖上层
- **内核自治**：所有业务编排逻辑集中在 Kernel 层的中央控制器
- **共享抽象**：类型定义、消息协议、日志规范全部下沉到 Shared 层
- **用户隔离**：每个用户拥有独立的文件空间
### 2.1.2 目录结构
```plaintext
YourBot/
├── src/
│   ├── gateway/                    # [1] 接入层
│   │   ├── channels/
│   │   │   ├── wechat.gateway.ts
│   │   │   ├── telegram.gateway.ts
│   │   │   ├── web.gateway.ts
│   │   │   └── api.gateway.ts
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts
│   │   │   ├── rate-limit.middleware.ts
│   │   │   └── transform.middleware.ts
│   │   └── index.ts
│   │
│   ├── kernel/                     # [2] 内核层
│   │   ├── central-controller.ts
│   │   ├── agents/
│   │   │   ├── agent-runtime.ts
│   │   │   ├── agent-pool.ts
│   │   │   ├── tool-executor.ts
│   │   │   └── stream-handler.ts
│   │   ├── sessioning/
│   │   │   ├── session-manager.ts
│   │   │   ├── session-store.ts
│   │   │   └── context-window.ts
│   │   ├── scheduling/
│   │   │   ├── scheduler.ts
│   │   │   ├── cron-parser.ts
│   │   │   └── job-registry.ts
│   │   └── tasking/
│   │       ├── task-queue.ts
│   │       ├── task-router.ts
│   │       ├── concurrency.ts
│   │       └── retry-policy.ts
│   │
│   ├── shared/                     # [3] 共享层
│   │   ├── agents/
│   │   ├── messaging/
│   │   ├── tasking/
│   │   ├── logging/
│   │   └── utils/
│   │
│   └── user-space/                 # [4] 用户空间层
│       ├── {userId}/
│       │   ├── .claude/
│       │   ├── memory/ (SOUL.md + USER.md)
│       │   └── workspace/ (uploads/ + CLAUDE.md)
│       └── template/
│
├── infra/                          # [5] 基础设施层
│   ├── docker/
│   ├── pm2/
│   ├── database/
│   └── scripts/
│
├── tsconfig.json
├── bunfig.toml
└── package.json
```

### 2.1.3 层间通信规约
各层之间的通信遵循严格的接口契约，全部基于 TypeScript 类型系统保障编译期安全：
```typescript
export interface LayerContract {
  readonly upstream: {
    invoke: (message: BotMessage) => Promise<void>;
    healthCheck: () => Promise<LayerHealth>;
  };
  readonly downstream: {
    sendResponse: (channelId: string, response: BotResponse) => Promise<void>;
    pushStream: (channelId: string, event: StreamEvent) => void;
  };
}
```

## 2.2 中央控制器 CentralController（核心亮点）
### 2.2.1 设计理念
中央控制器是 YourBot 架构中最关键的单一组件。参考 TELGENT 的 `central-controller.ts` 设计，它承担"交通指挥中心"的角色：**所有来自 Gateway 的消息、所有来自 Scheduler 的定时触发、所有来自外部 Webhook 的事件，都必须经过 CentralController 统一编排后才能进入执行流程**。核心优势：
1. **单一入口**：全系统只有一个消息入口点，便于审计、限流、降级
1. **编排自治**：CentralController 独立决策消息路径
1. **子系统协调**：Sessioning、AgentRuntime、Scheduling、Tasking 四大子系统通过 CentralController 协调
### 2.2.2 核心实现
```typescript
// src/kernel/central-controller.ts
export class CentralController {
  private static instance: CentralController | null = null;
  private readonly sessionManager: SessionManager;
  private readonly agentRuntime: AgentRuntime;
  private readonly scheduler: Scheduler;
  private readonly taskQueue: TaskQueue;
  private readonly activeRequests: Map<string, AbortController> = new Map();

  static getInstance(): CentralController {
    if (!CentralController.instance) {
      CentralController.instance = new CentralController();
    }
    return CentralController.instance;
  }

  async handleIncomingMessage(message: BotMessage): Promise<void> {
    const traceId = `trace_<equation>{Date.now()}_</equation>{Math.random().toString(36).slice(2, 8)}`;
    const session = await this.sessionManager.resolveSession(
      message.userId, message.channel, message.conversationId
    );
    const taskType = this.classifyIntent(message);
    const task: Task = {
      id: `task_${Date.now()}`,
      traceId, type: taskType, message, session,
      priority: this.calculatePriority(message, taskType),
      createdAt: Date.now(),
    };
    await this.orchestrate(task);
  }

  async orchestrate(task: Task): Promise<TaskResult> {
    switch (task.type) {
      case 'chat': return this.handleChatTask(task);
      case 'scheduled': return this.handleScheduledTask(task);
      case 'automation': return this.handleAutomationTask(task);
      case 'system': return this.handleSystemTask(task);
      default: return this.handleChatTask(task);
    }
  }
}
```

### 2.2.3 编排流程
```plaintext
收到消息
  ├─ 以 "/" 开头？ → SystemTask → 直接执行系统命令
  ├─ 匹配定时模式？ → ScheduledTask → 注册 Cron Job
  ├─ 匹配自动化关键词？ → AutomationTask → 入 Bunqueue 队列
  └─ 其他 → ChatTask → 即时 Agent 执行
       ├─ resolveSession()  — 会话复用/创建
       ├─ loadContext()      — 加载历史上下文
       ├─ agentRuntime.execute() — Agent 推理
       ├─ streamCallback()   — 实时推送 token
       └─ saveContext()      — 持久化上下文
```

## 2.3 内核层 Kernel 设计
内核层是 YourBot 的“大脑”，包含四大子系统：agents/、sessioning/、scheduling/、tasking/。
### 2.3.1 agents/ — Agent 实例管理与执行循环
AgentRuntime 是整个 AI 推理的核心执行器，负责从接收上下文到返回结果的完整流程。
```typescript
// src/kernel/agents/agent-runtime.ts
export class AgentRuntime {
  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    const { agentId, context, signal, streamCallback } = params;
    const agent = await this.agentPool.acquire(agentId);
    try {
      const systemPrompt = await this.buildSystemPrompt(agent);
      const response = await this.anthropic.messages.create({
        model: agent.config.model,
        max_tokens: agent.config.maxTokens,
        system: systemPrompt,
        messages: this.formatMessages(context.messages),
        stream: true,
      });
      // 流式处理
      let fullContent = '';
      for await (const event of response) {
        if (event.type === 'content_block_delta') {
          fullContent += event.delta.text;
          streamCallback?.({ type: 'text_delta', text: event.delta.text });
        }
      }
      return { content: fullContent, tokenUsage: response.usage };
    } finally {
      this.agentPool.release(agent);
    }
  }
}
```

AgentPool 对象池管理 Agent 实例的生命周期，支持复用、最大实例数控制、空闲超时回收。
```typescript
export class AgentPool {
  private readonly pool: Map<string, AgentInstance[]> = new Map();
  private readonly maxInstances = 100;
  private readonly idleTimeoutMs = 300000; // 5 分钟空闲回收

  async acquire(agentId: string): Promise<AgentInstance> {
    const instances = this.pool.get(agentId) ?? [];
    const idle = instances.find(i => i.state === 'idle');
    if (idle) { idle.state = 'processing'; return idle; }
    if (this.getTotalCount() >= this.maxInstances) {
      await this.evictLeastRecentlyUsed();
    }
    return this.createInstance(agentId);
  }
}
```

### 2.3.2 sessioning/ — 会话生命周期管理（内核级）
Sessioning 被提升到内核层，因为会话状态贯穿 Agent、Tool、Memory、Scheduler 四大子系统。
```typescript
// src/kernel/sessioning/session-manager.ts
export class SessionManager {
  private readonly store: SessionStore;
  private readonly contextWindow: ContextWindowManager;
  private readonly sessionTimeout = 1800000; // 30 分钟

  async resolveSession(userId: string, channel: string, conversationId: string): Promise<Session> {
    const key = `${userId}:<equation>{channel}:</equation>{conversationId}`;
    const existing = await this.store.findActive(key);
    if (existing && !this.isExpired(existing)) {
      existing.lastActiveAt = Date.now();
      await this.store.update(existing);
      return existing;
    }
    return this.createSession(userId, channel, conversationId);
  }

  async loadContext(sessionId: string): Promise<ConversationContext> {
    const session = await this.store.get(sessionId);
    const messages = await this.store.getMessages(sessionId);
    return this.contextWindow.fit(messages, session.agentConfig.maxContextTokens);
  }
}
```

ContextWindowManager 采用“滑动窗口 + 摘要压缩”策略：


| 策略 | token 阈值 | 行为 |
| --- | --- | --- |
| 全量保留 | < 60% | 保留所有历史消息 |
| 早期压缩 | 60-80% | 将较早的消息压缩为摘要 |
| 激进裁剪 | 80-95% | 只保留摘要 + 最近 N 轮 |
| 紧急截断 | > 95% | 只保留系统提示 + 最后 1 轮 |


### 2.3.3 scheduling/ — Cron/Interval 调度引擎
```typescript
// src/kernel/scheduling/scheduler.ts
export class Scheduler {
  private readonly jobs: Map<string, ScheduledJob> = new Map();
  private readonly timers: Map<string, Timer> = new Map();

  async register(config: ScheduleConfig): Promise<string> {
    const jobId = `job_${nanoid()}`;
    const job: ScheduledJob = {
      id: jobId,
      cronExpression: config.cronExpression,
      taskTemplate: config.taskTemplate,
      userId: config.userId,
      nextRunAt: this.calculateNextRun(config.cronExpression),
      status: 'active',
    };
    this.jobs.set(jobId, job);
    this.scheduleNextRun(job);
    return jobId;
  }
}
```

### 2.3.4 tasking/ — 任务队列与并发控制
基于 Bunqueue 的任务队列，提供优先级、并发控制、重试、超时能力。
```typescript
export class TaskQueue {
  private readonly queue: Queue;
  private readonly concurrency: ConcurrencyController;
  private readonly retryPolicy: RetryPolicy;

  constructor() {
    this.queue = new Queue({ concurrency: 25, timeout: 300000 });
    this.concurrency = new ConcurrencyController({ maxPerUser: 3, maxGlobal: 25 });
    this.retryPolicy = new RetryPolicy({ maxRetries: 3, backoff: 'exponential' });
  }

  async enqueue(task: Task): Promise<TaskResult> {
    await this.concurrency.acquire(task.metadata.userId);
    try {
      return await this.queue.add(() => this.executeTask(task), {
        priority: task.priority,
      });
    } finally {
      this.concurrency.release(task.metadata.userId);
    }
  }
}
```

## 2.4 共享层 Shared 设计
Shared 层是类型定义和公共工具的单一来源（Single Source of Truth）。
### 2.4.1 agents/ — Agent 类型定义
```typescript
// src/shared/agents/agent-config.types.ts
export interface AgentConfig {
  id: string;
  name: string;
  model: 'claude-sonnet-4-20250514' | 'claude-3-5-haiku-20241022';
  maxTokens: number;
  maxContextTokens: number;
  temperature: number;
  systemPromptPath: string;
  tools: ToolConfig[];
  constraints: AgentConstraints;
}

export interface AgentConstraints {
  maxConcurrentSessions: number;
  maxDailyTokens: number;
  allowedTools: string[];
  blockedCommands: string[];
  maxExecutionTimeMs: number;
}
```

### 2.4.2 messaging/ — 消息协议定义
```typescript
// src/shared/messaging/bot-message.types.ts
export interface BotMessage {
  id: string;
  channel: ChannelType;
  userId: string;
  userName: string;
  conversationId: string;
  content: string;
  contentType: 'text' | 'image' | 'file' | 'audio' | 'command';
  timestamp: number;
  metadata: Record<string, unknown>;
  replyTo?: string;
}

export type ChannelType = 'feishu' | 'telegram' | 'web' | 'api';

export interface StreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'error' | 'done';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  error?: string;
}
```

### 2.4.3 tasking/ — 任务接口定义
```typescript
export type TaskType = 'chat' | 'scheduled' | 'automation' | 'system';

export interface Task {
  id: string;
  traceId: string;
  type: TaskType;
  message: BotMessage;
  session: Session;
  priority: number;
  createdAt: number;
  signal?: AbortSignal;
  metadata: TaskMetadata;
}

export interface TaskResult {
  success: boolean;
  taskId: string;
  data?: unknown;
  error?: string;
  completedAt: number;
}
```

### 2.4.4 logging/ — 统一结构化日志
```typescript
// src/shared/logging/logger.ts
export class Logger {
  constructor(private readonly module: string) {}

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  private log(level: string, message: string, context?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...context,
    };
    console.log(JSON.stringify(entry));
  }
}
```

## 2.5 用户空间层 User Space
### 2.5.1 目录结构
```plaintext
user-space/{userId}/
├── .claude/
│   ├── settings.json     # Claude 运行时配置
│   └── permissions.json  # 工具权限配置
├── memory/
│   ├── SOUL.md           # 灵魂设定（人格/角色）
│   └── USER.md           # 用户资料（偏好/历史）
└── workspace/
    ├── uploads/
    │   └── images/
    └── CLAUDE.md           # 项目级指令
```

### 2.5.2 访问控制
```typescript
export class UserSpaceAccessor {
  private readonly basePath: string;

  constructor(private readonly userId: string) {
    this.basePath = `user-space/${userId}`;
  }

  async readMemory(file: 'SOUL.md' | 'USER.md'): Promise<string> {
    return Bun.file(`${this.basePath}/memory/${file}`).text();
  }

  async writeMemory(file: 'SOUL.md' | 'USER.md', content: string): Promise<void> {
    await Bun.write(`${this.basePath}/memory/${file}`, content);
  }
}
```

## 2.6 核心数据流
一次完整的用户对话请求流经以下节点：
```plaintext
用户发送消息
  │
  ▼
[Gateway] → 签名验证 → 限流检查 → 消息标准化
  │
  ▼
[CentralController] → 意图分类 → 任务构造
  │
  ├─ ChatTask → SessionManager.resolveSession()
  │                  → ContextWindow.fit()
  │                  → AgentRuntime.execute()
  │                  → StreamHandler → Gateway → 用户
  │
  ├─ ScheduledTask → Scheduler.register()
  │                    → Cron 触发时回到 CentralController
  │
  └─ SystemTask → 直接执行，返回结果
```

## 2.7 并发模型
YourBot 采用三级并发控制：


| 级别 | 控制器 | 限制 | 策略 |
| --- | --- | --- | --- |
| **全局级** | GlobalConcurrency | 25 并发任务 | 保护系统总体负载 |
| **用户级** | UserConcurrency | 3 并发/用户 | 防止单用户占用过多资源 |
| **Agent级** | AgentPool | 100 实例池 | LRU 回收空闲实例 |


## 2.8 错误恢复机制
```typescript
export class ErrorRecoveryManager {
  private readonly strategies: Map<string, RecoveryStrategy> = new Map([
    ['RATE_LIMIT', { action: 'retry', delay: 60000, maxRetries: 3 }],
    ['CONTEXT_TOO_LONG', { action: 'truncate', strategy: 'aggressive_trim' }],
    ['TOOL_TIMEOUT', { action: 'retry', delay: 5000, maxRetries: 2 }],
    ['AGENT_CRASH', { action: 'restart', cleanState: true }],
    ['SERVICE_UNAVAILABLE', { action: 'circuit_break', cooldownMs: 30000 }],
  ]);

  async recover(error: YourBotError, task: Task): Promise<RecoveryResult> {
    const strategy = this.strategies.get(error.code);
    if (!strategy) return { recovered: false, reason: 'NO_STRATEGY' };
    switch (strategy.action) {
      case 'retry': return this.retryWithBackoff(task, strategy);
      case 'truncate': return this.truncateAndRetry(task);
      case 'restart': return this.restartAgent(task);
      case 'circuit_break': return this.circuitBreak(error.code, strategy);
    }
  }
}
```

熔断器状态转换：Closed（正常通行）→ Open（快速失败）→ Half-Open（探测恢复）→ Closed。
## 2.9 TypeScript 工程配置
```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "paths": {
      "@gateway/*": ["./src/gateway/*"],
      "@kernel/*": ["./src/kernel/*"],
      "@shared/*": ["./src/shared/*"]
    }
  }
}
```

路径别名设计：
- `@gateway/*` → 接入层模块
- `@kernel/*` → 内核层模块
- `@shared/*` → 共享层模块
## 本章小结
本章完整定义了 YourBot 的五层架构体系，核心创新点包括：


| 创新点 | 设计决策 | 价值 |
| --- | --- | --- |
| CentralController | 单一入口点全局编排 | 可审计、可降级、可监控 |
| Sessioning 内核化 | 会话管理提升到内核层 | 跨子系统状态共享 |
| Shared 层抽象 | 类型/协议下沉到独立层 | 消除跨层重复定义 |
| User Space 隔离 | 每用户独立文件空间 | 数据安全、零干扰 |
