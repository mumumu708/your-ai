# YourBot AI 助手平台 — Claude Code 开发总览 Prompt

## 你的角色

你是 YourBot 项目的首席开发工程师。你将基于完整的技术设计文档，按章节逐步实现这个企业级 AI 助手平台。所有技术方案已在 `yourbot-docs/` 目录中按章节拆分，请严格遵循文档中的架构设计、接口定义和代码规范。

---

## 项目背景

**YourBot** 是一个企业级 AI 助手平台，通过多通道即时通讯集成（飞书、Telegram、Web），为团队和个人提供具备自主执行能力的 AI Agent 服务。每个 Agent 是一个拥有完整工作空间、持久记忆、可扩展工具集的"数字同事"。

### 核心技术栈

| 技术 | 选型 | 用途 |
|------|------|------|
| **Runtime** | Bun | 高性能 TypeScript 运行时，原生 TS 支持，~50ms 启动 |
| **Web 框架** | Hono | 零依赖（<14KB），多运行时支持，完整类型推导 |
| **AI 引擎** | Claude API (Anthropic) | 多轮对话推理，Agent SDK 集成 |
| **任务队列** | Bunqueue | Bun 原生内存队列，无需 Redis |
| **进程管理** | PM2 | fork/cluster 模式，自动重启，日志管理 |
| **数据库** | SQLite (Drizzle ORM) | 轻量持久化，会话/用户元数据 |
| **记忆存储** | Markdown 文件 | 零依赖、人类可读、AI 友好、Git 友好 |
| **工具协议** | MCP (Model Context Protocol) | 标准化工具接入，动态加载 |
| **语言** | TypeScript (严格模式) | 全栈类型安全 |

### 六大设计哲学

1. **Agent as Process** — 每个 Agent 独立进程，拥有独立工作空间/工具集/记忆/生命周期
2. **Markdown-First 记忆** — 所有持久化数据以 Markdown 存储（IDENTITY.md, SOUL.md, USER.md, AGENTS.md）
3. **Multi-Channel IM Unification** — Agent Runtime 完全不感知消息来源，通道差异在适配器层消化
4. **Self-Evolution** — Agent 可通过修改自身配置文件（SOUL.md, AGENTS.md, Skills）进化
5. **Minimal Dependency Surface** — 核心运行时仅 12 个包依赖，无 Docker 依赖
6. **Defense in Depth** — 四层安全：网关校验 → 控制平面认证 → Agent 工具白名单 → 进程隔离

### 五层分治架构

```
Layer 1 — Gateway（接入层）      : 飞书/Telegram/Web 通道适配、消息路由、认证鉴权
Layer 2 — Kernel（内核层）       : CentralController、Agent Runtime、Session、Scheduling、Tasking
Layer 3 — Shared（共享层）       : 类型定义、消息协议、日志工具、通用工具
Layer 4 — User Space（用户空间）  : 每用户独立目录，含 .claude/ memory/ workspace/ skills/
Layer 5 — Infra（基础设施）      : Docker、PM2 配置、数据库、部署脚本
```

### 项目目录结构

```
YourBot/
├── src/
│   ├── gateway/                  # [Layer 1] 接入层
│   │   ├── channels/             #   飞书/Telegram/Web/API 网关
│   │   ├── middleware/           #   认证、限流、消息转换中间件
│   │   ├── message-router.ts    #   统一消息路由器
│   │   └── index.ts
│   ├── kernel/                   # [Layer 2] 内核层
│   │   ├── central-controller.ts #   ★ 中央控制器（核心枢纽）
│   │   ├── agents/               #   Agent 运行时、对象池、生命周期
│   │   ├── sessioning/           #   会话管理、上下文窗口
│   │   ├── scheduling/           #   Cron 调度引擎
│   │   ├── tasking/              #   任务队列、并发控制、重试策略
│   │   ├── memory/               #   记忆管理、检索、压缩
│   │   └── evolution/            #   自进化引擎、技能生成
│   ├── shared/                   # [Layer 3] 共享层
│   │   ├── agents/               #   Agent 类型定义
│   │   ├── messaging/            #   BotMessage、StreamEvent 类型
│   │   ├── tasking/              #   Task、TaskResult 类型
│   │   ├── logging/              #   结构化日志
│   │   └── utils/                #   加密、时间、校验工具
│   └── community/                # 社区扩展层
├── user-space/                   # [Layer 4] 用户空间（每用户独立目录）
├── infra/                        # [Layer 5] 基础设施
├── tests/                        # 单元/集成/E2E 测试
├── tsconfig.json
├── bunfig.toml
├── package.json
└── ecosystem.config.js           # PM2 配置
```

---

## 技术文档索引

所有技术设计文档已按章节拆分，存放在 `yourbot-docs/` 目录：

| 文件名 | 章节 | 内容摘要 | 开发优先级 |
|--------|------|----------|-----------|
| `01-project-overview.md` | 第1章 项目概览与愿景 | 定位、设计哲学、技术选型、竞品对比 | 📖 通读（不需编码） |
| `02-system-architecture.md` | 第2章 系统架构设计 | 五层架构、CentralController、内核四大子系统、共享层、并发模型 | 🔴 P0 — 第1步 |
| `03-multi-channel-access.md` | 第3章 多通道接入系统 | Channel 抽象接口、飞书 WebSocket、Telegram Long Polling、Web WebSocket、消息路由 | 🔴 P0 — 第2步 |
| `04-agent-runtime-engine.md` | 第4章 Agent 运行时引擎 | 混合推理架构、ClaudeAgentBridge、LightLLMClient、Agent 生命周期状态机、会话管理、工作空间、进程隔离 | 🔴 P0 — 第3步 |
| `05-realtime-streaming.md` | 第5章 实时流式体验 | 流式架构、飞书卡片流式更新、Telegram/Web 流式、防抖节流 | 🟡 P1 — 第4步 |
| `06-tool-system-mcp.md` | 第6章 工具系统（MCP Server） | **完全托管 Claude Code 原生 MCP 机制**：工作空间初始化配置生成（.mcp.json + settings.json）、内置 MCP Server 实现（飞书/记忆/定时任务）、权限前置控制、监控日志 | 🔴 P0 — 第5步 |
| `07-scheduled-tasks.md` | 第7章 定时任务系统 | TELGENT 三引擎模型、Scheduler/Cron 引擎、TaskQueue、自然语言转 Cron | 🟡 P1 — 第6步 |
| `08-memory-system.md` | 第8章 记忆系统 | 三层记忆（Working/Session/Long-term）、AIEOS 协议、记忆检索引擎 | 🔴 P0 — 第7步 |
| `09-skill-system.md` | 第9章 技能系统 | **完全托管 Claude Code 原生 Commands 机制**：技能文件部署到 .claude/commands/、纯 Markdown 技能格式、脚本+模板支持、轻量管理 API | 🟡 P1 — 第8步 |
| `10-file-management.md` | 第10章 文件管理系统 | 文件系统架构、多通道文件处理、配额管理、安全 | 🟢 P2 — 第9步 |
| `11-security-multi-user.md` | 第11章 安全与多用户系统 | RBAC 权限模型、用户认证、进程隔离、数据加密、审计日志、速率限制 | 🔴 P0 — 穿插实现 |
| `12-project-structure-conventions.md` | 第12章 项目结构与开发规范 | 四层架构职责边界、代码规范、命名规范、测试策略（100%覆盖率）、Git 工作流 | 📖 全程遵循 |
| `13-deployment-operations.md` | 第13章 部署与运维 | PM2 配置、数据库初始化、监控告警、备份恢复、一键部署脚本、跨平台迁移 | 🟢 P2 — 最后实现 |

---

## 开发执行计划

### Phase 1：基础骨架（第2章 + 第12章）

**目标**：搭建项目骨架，建立五层目录结构和核心类型系统

```
读取文档：yourbot-docs/02-system-architecture.md + yourbot-docs/12-project-structure-conventions.md

任务：
1. 初始化项目：bun init，配置 tsconfig.json（严格模式）、bunfig.toml、package.json
2. 创建完整目录结构（src/gateway, src/kernel, src/shared, user-space, infra, tests）
3. 实现 shared/ 层：所有类型定义（BotMessage, AgentConfig, Task, StreamEvent 等）
4. 实现 shared/logging/ 统一结构化日志
5. 实现 CentralController 骨架（消息接收 → 意图分类 → 任务编排）
6. 配置 PM2 ecosystem.config.js
7. 编写对应单元测试
```

### Phase 2：通道接入层（第3章）

**目标**：实现多通道消息接入和统一路由

```
读取文档：yourbot-docs/03-multi-channel-access.md

任务：
1. 实现 IChannelAdapter 抽象接口
2. 实现飞书通道（WebSocket 长连接、事件订阅、消息卡片）
3. 实现 Telegram 通道（Long Polling、命令解析）
4. 实现 Web 通道（WebSocket 双向通信）
5. 实现 MessageRouter 统一路由器（通道 → BotMessage → CentralController）
6. 实现 ChannelManager 通道管理器（注册、启停、健康检查）
7. 编写对应单元测试和集成测试
```

### Phase 3：Agent 运行时引擎（第4章）

**目标**：实现 AI 推理核心，这是系统最复杂的部分

```
读取文档：yourbot-docs/04-agent-runtime-engine.md

任务：
1. 实现 AgentRuntime 核心执行器（Claude API 调用、流式处理）
2. 实现 AgentPool 对象池（实例复用、最大数控制、空闲回收）
3. 实现 AgentLifecycleManager 生命周期状态机
4. 实现混合推理架构：
   - ClaudeAgentBridge（Agent SDK 集成，复杂任务）
   - LightLLMClient（廉价模型直连，简单任务）
   - TaskComplexityClassifier（前置任务分类器）
5. 实现 SessionManager（会话创建/复用/销毁/超时）
6. 实现 SessionStore（SQLite 持久化）
7. 实现 ContextWindow 上下文窗口管理
8. 实现 WorkspaceManager（每用户隔离工作空间）
9. 实现进程级安全配置（命令过滤、目录隔离）
10. 编写完整单元测试
```

### Phase 4：流式体验（第5章）

**目标**：实现多平台实时流式响应

```
读取文档：yourbot-docs/05-realtime-streaming.md

任务：
1. 实现 StreamHandler 统一流式处理器
2. 实现飞书流式（消息卡片分批更新）
3. 实现 Telegram 流式（editMessageText 分批更新）
4. 实现 Web 流式（WebSocket 推送）
5. 定义 StreamEvent 协议（text_delta, tool_start, tool_end, complete, error）
6. 实现防抖与节流策略（飞书 300ms、Telegram 1s、Web 50ms）
7. 编写对应测试
```

### Phase 5：工具系统 MCP（第6章）

**目标**：实现完全托管 Claude Code 的 MCP 工具系统（轻量配置生成 + 内置 Server 实现）

> **架构说明**：MCP Server 的生命周期管理（进程启动/停止/健康检查/重启）完全由 Claude Code 原生机制承担，YourBot 仅负责在工作空间初始化时生成配置文件，以及实现内置 MCP Server 的工具逻辑。

```
读取文档：yourbot-docs/06-tool-system-mcp.md

任务：
1. 实现 McpConfigGenerator —— 工作空间初始化时生成 .mcp.json 和 .claude/settings.json
   - 内置 Server 配置（飞书/记忆/定时任务）
   - 租户第三方 Server 配置（根据权限过滤）
   - 用户自定义 Server 配置
   - permissions allow/deny 列表生成
2. 实现内置 MCP Server（标准 MCP 协议，stdio 传输）：
   - 飞书 MCP Server（文档读写、消息发送、搜索、日历）
   - 记忆系统 MCP Server（记忆存取与语义检索）
   - 定时任务 MCP Server（任务创建/查询/取消）
3. 实现 Server 内部鉴权中间件（基于环境变量的 userId/tenantId 校验）
4. 实现敏感操作审批机制
5. 实现 ToolCallMonitor（解析 Claude Code stream-json 输出中的 tool_use/tool_result 事件）
6. 实现 MCP Server 侧结构化日志（McpServerLogger）
7. 实现审计日志
8. 编写对应测试
```

### Phase 6：定时任务系统（第7章）

**目标**：实现 Cron 调度和任务队列

```
读取文档：yourbot-docs/07-scheduled-tasks.md

任务：
1. 实现 Scheduler 引擎（Cron 表达式解析、Job 注册/触发）
2. 实现 TaskQueue（Bunqueue 封装、优先级、并发控制、重试策略）
3. 实现自然语言到 Cron 表达式转换（通过 LLM）
4. 实现定时任务完整生命周期（创建→调度→执行→结果回调→清理）
5. 编写对应测试
```

### Phase 7：记忆系统（第8章）

**目标**：实现三层记忆架构和 AIEOS 协议

```
读取文档：yourbot-docs/08-memory-system.md

任务：
1. 实现三层记忆架构：
   - Working Memory（当前会话上下文，内存）
   - Session Memory（会话摘要，Markdown 文件）
   - Long-term Memory（用户画像/知识库，Markdown 文件）
2. 实现层级迁移流程（Working → Session → Long-term）
3. 实现 AIEOS 协议文件管理（IDENTITY.md, SOUL.md, USER.md, AGENTS.md）
4. 实现 MemoryRetriever 记忆检索引擎
5. 实现 MemoryCompressor 记忆压缩（上下文窗口溢出时摘要压缩）
6. 编写对应测试
```

### Phase 8：技能系统（第9章）

**目标**：实现完全托管 Claude Code 的技能系统（文件部署 + 轻量管理 API）

> **架构说明**：技能的发现、注册、匹配、注入、热更新完全由 Claude Code 原生 Custom Slash Commands 机制承担。YourBot 仅负责在工作空间初始化时将技能文件部署到 `.claude/commands/` 目录。

```
读取文档：yourbot-docs/09-skill-system.md

任务：
1. 实现 SkillDeployer —— 工作空间初始化时将技能文件部署到 .claude/commands/ 目录
   - 内置技能部署
   - 租户市场技能部署
   - 用户自定义技能部署
2. 编写内置技能 Markdown 文件（纯 Markdown 格式，使用  占位符）：
   - commit.md（Git 提交规范）
   - review-pr.md（PR 审查）
   - deploy-staging.md + 配套 scripts/assets（预发部署）
3. 实现技能管理 API（Hono 路由）：
   - POST /api/skills —— 添加技能（写入文件）
   - DELETE /api/skills/:name —— 删除技能（删除文件）
   - GET /api/skills —— 列出技能
4. 实现旧版 SKILL.md 格式迁移脚本
5. 集成到 WorkspaceInitializer（与 McpConfigGenerator 同阶段执行）
6. 编写对应测试
```

### Phase 9：文件管理 + 安全（第10章 + 第11章）

**目标**：实现文件管理和完整的安全体系

```
读取文档：yourbot-docs/10-file-management.md + yourbot-docs/11-security-multi-user.md

任务：
1. 实现文件系统架构（上传/下载/列表/删除）
2. 实现多通道文件处理（飞书文件 API、Telegram 文件 API、Web 上传）
3. 实现文件配额管理（每用户空间限制）
4. 实现 RBAC 权限模型（admin/user/guest 角色）
5. 实现用户认证（飞书 OAuth / Telegram Bot Token / Web JWT）
6. 实现进程级安全隔离
7. 实现数据加密（敏感字段 AES-256 加密）
8. 实现审计日志系统
9. 实现速率限制中间件
10. 编写对应测试
```

### Phase 10：部署与运维（第13章）

**目标**：实现一键部署和运维工具链

```
读取文档：yourbot-docs/13-deployment-operations.md

任务：
1. 完善 PM2 配置（多进程、内存限制、日志轮转）
2. 实现数据库初始化脚本（SQLite schema）
3. 实现健康检查和监控端点
4. 实现备份与恢复脚本
5. 实现一键部署脚本（Pre-flight 预检 + 自动安装依赖 + 启动）
6. 实现跨平台迁移工具（导出/导入）
7. 实现容灾与备份设计
8. 编写 E2E 测试
```

---

## 开发规范提示（全程遵循）

1. **TypeScript 严格模式**：`strict: true`，不允许 `any` 类型，所有函数必须有返回类型注解
2. **命名规范**：文件用 kebab-case，类用 PascalCase，函数/变量用 camelCase，常量用 UPPER_SNAKE_CASE
3. **测试要求**：100% 单元测试覆盖率，使用 Bun 内置测试框架，遵循 Arrange-Act-Assert 模式
4. **错误处理**：使用自定义错误类继承体系，禁止吞掉异常，所有异步操作必须有超时机制
5. **日志规范**：使用 shared/logging 的结构化日志，包含 traceId、模块名、操作名
6. **Git 工作流**：feature 分支开发，commit message 遵循 Conventional Commits 规范

---

## 如何使用

**逐章开发**：每次开始一个 Phase 时，先完整阅读对应的 `yourbot-docs/XX-*.md` 文档，理解完整的设计方案后再开始编码。

**示例指令**：

```
# 开始 Phase 1
请阅读 yourbot-docs/02-system-architecture.md 和 yourbot-docs/12-project-structure-conventions.md，
然后开始实现 Phase 1：项目骨架搭建。

# 开始 Phase 3
请阅读 yourbot-docs/04-agent-runtime-engine.md，然后开始实现 Phase 3：Agent 运行时引擎。
注意这是系统最复杂的部分，需要实现混合推理架构和完整的生命周期管理。
```

**注意事项**：
- 每个 Phase 完成后，确保所有测试通过再进入下一个 Phase
- 第11章（安全）的内容应穿插在各 Phase 中实现，而非集中在最后
- 遇到文档中的接口定义时，请严格遵循，不要自行修改签名
