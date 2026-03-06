# YourBot

个人 AI 助手平台，支持多通道接入（飞书 / Telegram / Web），具备记忆系统、自我进化和个性化配置能力。

## 技术栈

- **运行时**: [Bun](https://bun.sh)
- **HTTP 框架**: [Hono](https://hono.dev)
- **LLM**: Claude Code Bridge（复杂任务）+ LightLLM（简单任务，兼容 OpenAI API）
- **记忆存储**: [OpenViking](./docs/14-openviking-setup.md)（向量检索 + 图谱）
- **通道 SDK**: `@larksuiteoapi/node-sdk`（飞书）、`telegraf`（Telegram）、Bun WebSocket（Web）
- **Lint / Format**: [Biome](https://biomejs.dev)
- **进程管理**: PM2

## 项目结构

```
src/
├── gateway/            # HTTP 服务、通道管理、消息路由
│   ├── channels/       # 飞书 / Telegram / Web 通道实现
│   ├── middleware/      # 认证、限流、转换中间件
│   └── index.ts        # 入口文件
├── kernel/             # 核心业务逻辑
│   ├── agents/         # Agent 运行时、Claude Bridge、LightLLM
│   ├── memory/         # 配置加载、上下文管理、OpenViking 客户端
│   ├── onboarding/     # 新用户引导流程
│   ├── evolution/      # 知识路由、冲突解决、自我进化
│   ├── files/          # 文件管理、上传处理
│   ├── scheduling/     # 定时任务、Cron 解析
│   ├── sessioning/     # 会话管理
│   ├── streaming/      # 流式响应
│   ├── classifier/     # 意图分类
│   ├── workspace/      # 工作空间 & MCP 配置
│   ├── skills/         # 技能系统
│   ├── security/       # 加密、限流、RBAC
│   ├── monitoring/     # 审计日志、告警
│   ├── tasking/        # 任务队列、并发控制
│   └── central-controller.ts
├── shared/             # 共享类型、工具、日志
├── lessons/            # 错误检测 → 经验提取
└── community/          # 插件 / 市场（预留）
config/                 # AIEOS 协议文件（全局默认）
├── SOUL.md             # 行为准则
├── IDENTITY.md         # 身份定义
├── USER.md             # 用户画像
└── AGENTS.md           # Agent 配置
user-space/             # 每用户隔离的配置和数据
skills/                 # 内置 / 自定义技能
```

## 快速开始

### 环境要求

- [Bun](https://bun.sh) >= 1.2
- [PM2](https://pm2.keymetrics.io) (`npm install -g pm2`)
- [GitHub CLI](https://cli.github.com) (`brew install gh`)
- [OpenViking Server](./docs/14-openviking-setup.md)

### 安装

```bash
bun install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env，填入必要的 API Key 和通道凭证
```

关键配置项：

| 变量 | 说明 | 必填 |
|------|------|------|
| `ENABLED_CHANNELS` | 启用的通道，逗号分隔（`feishu,telegram,web`） | 是 |
| `LIGHT_LLM_API_KEY` | LightLLM API Key（兼容 OpenAI） | 是 |
| `LIGHT_LLM_BASE_URL` | LLM API 地址（默认 OpenAI） | 否 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭证 | 启用飞书时 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | 启用 Telegram 时 |
| `OPENVIKING_URL` | OpenViking 服务地址（默认 `http://localhost:1933`） | 是 |

### 启动服务

**生产模式**（PM2，启动全部服务）：

```bash
pm2 start ecosystem.config.cjs
```

启动 3 个进程：
- `openviking-server` — 记忆存储服务
- `yourbot-gateway` — 主网关（HTTP + WebSocket）
- `yourbot-scheduler` — 定时任务调度

**开发模式**（仅 gateway）：

```bash
bun run dev
```

### 停止服务

```bash
# 停止所有进程
pm2 stop ecosystem.config.cjs

# 停止并删除所有进程
pm2 delete ecosystem.config.cjs
```

### 查看日志

```bash
pm2 logs                    # 查看所有进程日志
pm2 logs yourbot-gateway    # 查看网关日志
```

日志文件位于 `logs/` 目录。

## 开发

### 常用命令

```bash
bun test                    # 运行测试
bun test --coverage         # 测试覆盖率
bun run lint                # Lint 检查
bun run lint:fix            # 自动修复 Lint 问题
bun run format              # 格式化代码
```

### 调试页面

启动服务后访问 `http://localhost:3000/debug`，可通过 WebSocket 直接与 Bot 对话。

### 健康检查

```bash
curl http://localhost:3000/health
```

## 核心概念

### AIEOS 协议

每个用户拥有 4 个配置文件，定义 AI 助手的行为：

- **SOUL.md** — 核心行为准则和价值观
- **IDENTITY.md** — 身份定义和交流风格
- **USER.md** — 用户个人画像和偏好
- **AGENTS.md** — Agent 能力配置

配置加载优先级：`user-space/{userId}/memory/` → VikingFS → `config/`（全局默认）

### 新用户引导

首次用户发送消息时自动触发引导流程，通过 4 步对话生成个性化的 SOUL.md 和 IDENTITY.md。可随时发送 `/setup` 重新配置。

### 消息处理流程

```
用户消息 → 通道接收 → 中间件（认证/限流/转换）→ 消息路由
  → 引导检测 → 文件上传检测 → 意图分类
  → chat / scheduled / automation / system
  → 知识路由（配置 + 记忆检索 + 冲突解决）→ Agent 执行 → 响应
```

## 许可证

私有项目，未经授权不得分发。
