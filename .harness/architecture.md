# 架构地图

## 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Gateway (src/gateway/)                                     │
│  HTTP/WS 服务 · 通道管理 · 中间件 · 消息路由                    │
│                                                             │
│  index.ts          — Hono HTTP 服务入口，注册路由/通道/中间件     │
│  message-router.ts — 统一消息路由，分发到 CentralController     │
│  channel-manager.ts— 通道注册与生命周期管理                      │
│  channels/         — Feishu/Telegram/Web 通道实现              │
│    feishu-cardkit-client.ts — 飞书 CardKit 流式卡片 API 封装   │
│    adapters/       — 各通道的流式输出适配器                      │
│  middleware/       — auth · rate-limit · transform 中间件      │
├─────────────────────────────────────────────────────────────┤
│  Kernel (src/kernel/)                                       │
│  核心业务逻辑 · 编排 · 记忆 · 进化                               │
│                                                             │
│  central-controller.ts — 单例编排器，消息入口 → 分类 → 分发       │
│  agents/               — AgentRuntime + ClaudeAgentBridge    │
│    agent-runtime.ts    — 根据复杂度路由到 Claude/LightLLM       │
│    claude-agent-bridge.ts — Claude CLI subprocess 封装        │
│    light-llm-client.ts — OpenAI 兼容 API 客户端               │
│    process-security.ts — 子进程安全控制                         │
│    agent-lifecycle.ts  — Agent 生命周期管理                     │
│  classifier/           — TaskClassifier（统一分类：规则+LLM→UnifiedClassifyResult）│
│  memory/               — 记忆系统                              │
│    config-loader.ts    — 全局 AIEOS 配置加载（config/ 目录）     │
│    user-config-loader.ts — 用户级配置加载（三级回退）             │
│    context-manager.ts  — 上下文压缩/刷新                        │
│    working-memory.ts   — 工作记忆                              │
│    memory-retriever-v2.ts — 记忆检索                           │
│    session-memory-extractor.ts — 对话记忆提取                   │
│    openviking/         — OpenViking 向量/图存储客户端            │
│    graph/              — 实体关系图管理                          │
│  evolution/            — 自我进化系统                           │
│    knowledge-router.ts — 知识路由，构建 system prompt            │
│    post-response-analyzer.ts — 回复后分析（纠错→经验）           │
│    evolution-scheduler.ts — 进化调度                            │
│    token-budget-allocator.ts — Token 预算分配                   │
│    conflict-resolver.ts — 配置冲突解决                          │
│    error-to-rule-pipeline.ts — 错误→规则管道                    │
│  onboarding/           — 新用户引导（多步对话状态机）              │
│  sessioning/           — 会话管理 · 消息序列化 · WorktreePool 并行隔离 │
│  scheduling/           — 定时任务（NL→Cron + 调度器 + 取消管理 + JobStore）│
│  prompt/               — System Prompt 组装器（DD-018）            │
│    system-prompt-builder.ts — 冻结区构建（session 级）              │
│    prepend-context-builder.ts — 首轮 OVERRIDE 注入                │
│    turn-context-builder.ts — 每轮动态注入（memory/guidance/delta） │
│    memory-snapshot-builder.ts — MEMORY.md 快照生成                │
│  skills/               — 技能管理与部署                          │
│  workspace/            — 用户工作空间初始化 + MCP 配置            │
│  streaming/            — 流式输出处理                            │
│  media/                — 多媒体处理（下载·理解·编排）               │
│    media-types.ts      — 媒体配置常量 + MIME 检测                  │
│    media-downloader.ts — 从各通道下载/解码媒体并验证                │
│    media-understanding.ts — 调用 Vision API 生成图片描述           │
│    media-processor.ts  — 串联下载+理解的编排器                     │
│  files/                — 文件上传处理 + 配额管理                  │
│  tasking/              — 任务调度 + 持久化 + 并发控制              │
│    task-store.ts       — SQLite 任务持久化（CRUD + 启动恢复）      │
│    task-dispatcher.ts  — 会话串行 + 跨会话并发调度器                │
│    task-queue.ts       — (旧) 任务队列（待废弃）                   │
│    concurrency-controller.ts — (旧) 并发控制（待废弃）             │
│  security/             — 加密 · RBAC · 限流                     │
│  monitoring/           — 审计日志 · 告警规则 · 工具调用监控        │
├─────────────────────────────────────────────────────────────┤
│  Shared (src/shared/)                                       │
│  纯类型 · 工具函数 · 零业务依赖                                  │
│                                                             │
│  messaging/  — BotMessage/StreamEvent/ChannelAdapter/MediaAttachment 类型│
│  tasking/    — Task/TaskType/TaskResult/TaskRecord/TaskPayload 类型│
│  classifier/ — UnifiedClassifyResult 等分类器类型              │
│  errors/     — YourBotError + ERROR_CODES                    │
│  logging/    — Logger 类 + 日志级别                            │
│  utils/      — crypto · validators · time 工具函数             │
│  agents/     — Agent 相关类型                                  │
├─────────────────────────────────────────────────────────────┤
│  Lessons (src/lessons/)                                     │
│  错误检测 · 经验提取 · 经验更新                                  │
│                                                             │
│  error-detector.ts     — 错误模式检测                          │
│  lesson-extractor.ts   — 从对话中提取经验                       │
│  lessons-updater.ts    — 经验写入存储                           │
│  manual-management.ts  — 手动管理经验                           │
├─────────────────────────────────────────────────────────────┤
│  UserSpace (外部: $USER_SPACE_ROOT)                           │
│  每用户: AIEOS 协议文件 + 记忆数据 + MCP 配置                    │
│  (已迁移至 ~/.your-ai/user-space/，可通过 USER_SPACE_ROOT 配置) │
├─────────────────────────────────────────────────────────────┤
│  Infra                                                      │
│  infra/       — database · docker · pm2 · scripts            │
│  mcp-servers/ — memory · feishu · scheduler · shared         │
│  skills/      — builtin skills (commit/deep-research/...)    │
│  scripts/     — setup-openviking.sh                          │
└─────────────────────────────────────────────────────────────┘
```

## 依赖规则

| 源层 | 允许引用 | 禁止引用 |
|------|---------|---------|
| src/gateway/ | src/kernel/(公开 API), src/shared/ | — |
| src/kernel/ | src/shared/ | src/gateway/ |
| src/shared/ | 无 | src/gateway/, src/kernel/, src/lessons/ |
| src/lessons/ | src/shared/ | src/gateway/, src/kernel/ |
| mcp-servers/ | mcp-servers/shared/ | src/kernel/(内部) |
| kernel 子模块间 | 对方 index.ts | 对方内部文件 |

## 消息流路径

```
User → Channel (Feishu/Telegram/Web)
  → ChannelManager.createHandler()
  → MiddlewarePipeline (auth → rate-limit → transform)
  → MessageRouter.createHandler()
  → CentralController.handleIncomingMessage()
  │
  ├── OnboardingManager (首次用户 → 引导流程)
  ├── FileUploadHandler (文件上传 → USER.md 处理)
  │
  └── classifyIntent() → UnifiedClassifyResult { taskType, complexity }
        ├── 'chat'       → handleChatTask()
        │                    → SessionManager.resolveSession()
        │                    → KnowledgeRouter.buildContext() (AIEOS + 记忆)
        │                    → AgentRuntime.execute()
        │                        ├── simple → LightLLM (DeepSeek/Qwen/OpenAI)
        │                        └── complex → ClaudeAgentBridge (claude CLI)
        │                    → PostResponseAnalyzer (纠错→经验)
        │                    → StreamHandler → ChannelStreamAdapter
        │                        ├── Feishu → CardKitClient (流式卡片)
        │                        ├── Telegram → editMessage
        │                        └── Web → WebSocket push
        │
        ├── 'scheduled'  → handleScheduledTask()
        │                    → nlToCron() + scheduler.register(channel)
        │                    → JobStore 持久化到 data/scheduler/jobs.json
        │                    → 定时触发 → executor → executeChatPipeline()
        │                    → channel.sendMessage() 推送结果
        ├── 'automation' → handleAutomationTask()
        └── 'system'     → handleSystemTask()
```

## 关键单例与依赖注入

- `CentralController.getInstance(deps)` — 全局唯一编排器
- 依赖通过 `CentralControllerDeps` 接口注入
- 在 `src/gateway/index.ts` 中完成所有组件的创建和组装

## AIEOS 协议

config/ 目录存放全局默认配置模板：
- `SOUL.md` — AI 助手的核心人格
- `IDENTITY.md` — AI 助手的身份信息
- `USER.md` — 用户画像模板
- `AGENTS.md` — Agent 行为配置

每个用户的 user-space 中有自己的副本（通过 UserConfigLoader 三级回退加载）：
1. 本地文件系统（user-space/{userId}/memory/）
2. OpenViking 文件存储
3. 全局默认（config/）

## 技术栈

- **Runtime**: Bun
- **HTTP**: Hono
- **LLM**: Claude Code CLI (复杂) + LightLLM/OpenAI-compatible (简单)
- **存储**: OpenViking (向量/图) + SQLite (drizzle-orm)
- **通道**: Feishu (Lark SDK) · Telegram (Telegraf) · Web (WebSocket)
- **Lint**: Biome
- **部署**: PM2
