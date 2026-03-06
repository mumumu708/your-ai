# DD-004: 网关与通道系统

- **状态**: Implemented
- **创建日期**: 2026-03-06

## 背景

YourBot 需要支持多通道接入（飞书、Telegram、Web），每个通道有不同的消息格式、认证方式和流式输出约束。需要一套统一的网关层来屏蔽通道差异。

## 架构总览

```
                ┌─────────────────────────────────────┐
                │  HTTP Server (Hono, PORT=3000)       │
                │  GET /health · POST /api/messages    │
                │  GET /debug                          │
                └────────────┬────────────────────────┘
                             │
     ┌───────────────────────┼────────────────────────┐
     │                       │                        │
     ▼                       ▼                        ▼
 FeishuChannel         TelegramChannel           WebChannel
 (Lark SDK WS)        (Telegraf Polling)      (Bun WS, PORT=3001)
     │                       │                        │
     └───────────────────────┼────────────────────────┘
                             │
                    MiddlewarePipeline
                  (Auth → RateLimit → Transform)
                             │
                        MessageRouter
                             │
                     CentralController
```

## 启动流程 (src/gateway/index.ts)

1. **LLM 客户端初始化** — 按环境变量条件创建 ClaudeAgentBridge 和 LightLLMClient
2. **核心组件** — TaskClassifier, WorkspaceManager, CentralController (单例)
3. **消息路由** — MessageRouter 接收 CentralController
4. **中间件管道** — 创建 Auth/RateLimit/Transform 中间件
5. **通道管理** — ChannelManager 注册 router + middleware
6. **响应调度** — Controller → ChannelManager.sendMessage() 回路
7. **通道注册** — 按 `ENABLED_CHANNELS` 环境变量动态注册
8. **WebSocket** — 独立 Bun 服务器在 WS_PORT 上运行
9. **优雅关闭** — SIGINT/SIGTERM 处理

## 通道实现

### 基类 (BaseChannel)

```
abstract class BaseChannel implements IChannel
  ├── type: ChannelType (abstract)
  ├── name: string (abstract)
  ├── initialize(): Promise<void>        ← 通道特定初始化
  ├── shutdown(): Promise<void>          ← 通道特定清理
  ├── sendMessage(userId, content)       ← 发送响应
  ├── updateMessage(messageId, content)  ← 编辑已发消息
  ├── sendStreamChunk(userId, chunk)     ← 流式输出
  ├── transformToStandardMessage(raw)    ← 统一消息格式
  ├── onMessage(handler)                 ← 设置消息处理回调
  └── emitMessage(message)              ← 调用 handler
```

### 飞书通道 (FeishuChannel)

| 维度 | 实现 |
|------|------|
| SDK | @larksuiteoapi/node-sdk (Client + WSClient) |
| 连接方式 | WebSocket 长连接，自动重连 |
| 消息接收 | EventDispatcher 监听 `im.message.receive_v1` |
| 去重 | processedMessages Set，5 分钟 TTL 自动清理 |
| 消息发送 | `im.message.create` API |
| 消息更新 | `im.message.patch` API |
| 文件下载 | 原生 fetch + 3 次指数退避重试 (500ms/1s) |
| 流式输出 | 300ms 节流，累积文本 → 创建/更新卡片消息 |
| 完成时按钮 | 复制 / 重新生成 / 继续追问 |

### Telegram 通道 (TelegramChannel)

| 维度 | 实现 |
|------|------|
| SDK | Telegraf |
| 连接方式 | Polling (bot.launch()) |
| 消息接收 | `bot.on('message')` 事件 |
| 消息发送 | `bot.telegram.sendMessage()` |
| 消息更新 | `bot.telegram.editMessageText()` |
| 消息ID格式 | `chatId:messageId` |
| 流式输出 | 2000ms 节流（受 Telegram API 限流约束）|

### Web 通道 (WebChannel)

| 维度 | 实现 |
|------|------|
| 服务器 | Bun.serve 原生 WebSocket，独立端口 (WS_PORT) |
| 连接管理 | `Map<connectionId, ServerWebSocket>` |
| 认证 | upgrade 前调用 wsAuthHandler（JWT 或 dev_bypass）|
| 协议-入站 | `{ content, userId?, metadata?, contentType?, fileContent? }` |
| 协议-出站 | `{ type: 'message'\|'stream'\|'error'\|'connected', data }` |
| 文件上传 | base64 编码的 fileContent 字段 |
| 流式输出 | 无节流，实时 WebSocket 推送 |

## 中间件管道

中间件以**反序**组合——第一个中间件包裹最外层。

```
请求 → Auth → RateLimit → Transform → MessageRouter Handler
```

### Auth 中间件

按通道使用不同策略：

| 通道 | 认证方式 |
|------|---------|
| Feishu | 验证 userId 存在（SDK 层已认证）|
| Telegram | 验证 userId 存在（Telegraf 已认证）|
| Web | JWT 验证（HS256，Bun crypto.subtle）|
| API | API Key（Authorization Bearer 或 X-API-Key 头）|

开发环境 `devBypass` 可跳过认证。

### RateLimit 中间件

- 单例 RateLimiter，按 userId 限流
- 返回 `{ allowed, remaining, resetMs, reason }`
- 超限抛出 `YourBotError(RATE_LIMIT_EXCEEDED)`
- API 路由设置 `X-RateLimit-Remaining/Reset` 响应头

### Transform 中间件

消息标准化处理：
1. 确保 `message.id`（缺失则生成）
2. `content` 去首尾空白
3. 确保 `timestamp`（缺失则 Date.now()）
4. 添加 `metadata.traceId`（请求追踪）
5. **userId 安全净化** — 只保留 `[a-zA-Z0-9_\-\.:]`

## 流式输出适配器

每个通道有独立的 StreamAdapter：

```typescript
interface ChannelStreamAdapter {
  onStreamStart(messageId: string): Promise<void>;
  sendChunk(text: string, protocol: StreamProtocol): Promise<void>;
  sendDone(finalText: string, protocol: StreamProtocol): Promise<void>;
  sendError(error: string, protocol: StreamProtocol): Promise<void>;
}
```

| 适配器 | 节流间隔 | 策略 |
|--------|---------|------|
| FeishuStreamAdapter | 300ms | 累积文本 → 创建/更新卡片 |
| TelegramStreamAdapter | 2000ms | 累积文本 → 发送/编辑消息 |
| WebStreamAdapter | 0ms | 实时 WebSocket 推送 |

## 消息类型 (src/shared/messaging/)

```typescript
interface BotMessage {
  id: string;
  channel: 'feishu' | 'telegram' | 'web' | 'api';
  userId: string;
  userName: string;
  conversationId: string;
  content: string;
  contentType: 'text' | 'image' | 'file' | 'audio' | 'command';
  timestamp: number;
  metadata: Record<string, unknown>;
  replyTo?: string;
}

interface StreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'error' | 'done';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  error?: string;
}
```

## 关键设计决策

1. **双端口架构** — HTTP (Hono) 和 WebSocket (Bun 原生) 分离，各自独立端口
2. **抽象基类** — BaseChannel 统一接口，各通道继承实现
3. **中间件组合** — 可插拔，顺序可配置
4. **飞书长连接** — 使用 WSClient 而非 Webhook，减少网络配置
5. **节流策略差异化** — 飞书 300ms、Telegram 2000ms、Web 实时
6. **Fire-and-forget 消息处理** — 飞书 handler 不阻塞 SDK

## 文件清单

| 文件 | 职责 |
|------|------|
| src/gateway/index.ts | HTTP 服务入口 + 组件组装 |
| src/gateway/message-router.ts | 消息路由 + 响应分发 |
| src/gateway/channel-manager.ts | 通道注册 + 中间件组合 |
| src/gateway/channels/base-channel.ts | 通道抽象基类 |
| src/gateway/channels/feishu.gateway.ts | 飞书实现 |
| src/gateway/channels/telegram.gateway.ts | Telegram 实现 |
| src/gateway/channels/web.gateway.ts | Web/WebSocket 实现 |
| src/gateway/channels/adapters/*.ts | 流式输出适配器 |
| src/gateway/middleware/pipeline.ts | 中间件组合器 |
| src/gateway/middleware/auth.middleware.ts | 认证中间件 |
| src/gateway/middleware/rate-limit.middleware.ts | 限流中间件 |
| src/gateway/middleware/transform.middleware.ts | 消息标准化 |
| src/shared/messaging/*.ts | 消息/流式事件类型定义 |
