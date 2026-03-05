# 第3章 多通道接入系统
> **本章目标**：设计一个统一的多通道接入架构，使 YourBot 能在飞书、Telegram、Web 等平台上提供一致的 AI 助手体验。
## 3.1 统一通道抽象
YourBot 通过 Channel 接口抽象消除平台差异，所有通道实现统一的 `IChannel` 接口。
```typescript
// src/gateway/channels/channel.interface.ts
export interface IChannel {
  readonly type: ChannelType;
  readonly name: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  sendMessage(userId: string, content: BotResponse): Promise<void>;
  updateMessage(messageId: string, content: BotResponse): Promise<void>;
  sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void>;
  onMessage(handler: MessageHandler): void;
}

// 通道基类提供公共能力
export abstract class BaseChannel implements IChannel {
  protected readonly logger: Logger;
  protected messageHandler?: MessageHandler;
  abstract readonly type: ChannelType;
  abstract readonly name: string;

  protected async transformToStandardMessage(
    rawMessage: unknown
  ): Promise<BotMessage> {
    // 子类实现平台特定的消息转换
    throw new Error('Must be implemented by subclass');
  }
}
```

## 3.2 飞书通道（WebSocket）
飞书通道采用 Lark SDK 的长连接方式，支持事件订阅和卡片更新。
```typescript
// src/gateway/channels/feishu.gateway.ts
export class FeishuChannel extends BaseChannel {
  readonly type = 'feishu';
  readonly name = 'Feishu Bot';
  private client: lark.Client;
  private wsClient: lark.WSClient;

  async initialize(): Promise<void> {
    this.client = new lark.Client({ appId: config.appId, appSecret: config.appSecret });
    this.wsClient = new lark.WSClient({
      appId: config.appId, appSecret: config.appSecret,
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data) => this.handleMessage(data),
      }),
    });
    await this.wsClient.start();
  }

  async sendMessage(userId: string, content: BotResponse): Promise<void> {
    // 支持文本、卡片、图片等多种消息类型
    await this.client.im.message.create({
      receive_id_type: 'chat_id',
      data: { receive_id: userId, msg_type: content.type, content: content.payload },
    });
  }

  // 飞书卡片流式更新（打字机效果）
  async updateStreamCard(messageId: string, accumulatedText: string): Promise<void> {
    const card = this.buildStreamCard(accumulatedText);
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }
}
```

## 3.3 Telegram 通道（Long Polling）
```typescript
// src/gateway/channels/telegram.gateway.ts
export class TelegramChannel extends BaseChannel {
  readonly type = 'telegram';
  readonly name = 'Telegram Bot';
  private bot: Telegraf;

  async initialize(): Promise<void> {
    this.bot = new Telegraf(config.telegramToken);
    this.bot.on('message', async (ctx) => {
      const standardMessage = await this.transformTelegramMessage(ctx.message);
      this.messageHandler?.(standardMessage);
    });
    await this.bot.launch();
  }

  async sendMessage(userId: string, content: BotResponse): Promise<void> {
    // 支持 Markdown 格式、图片、文件
    await this.bot.telegram.sendMessage(userId, content.text, {
      parse_mode: 'MarkdownV2',
    });
  }

  // Telegram 流式输出：分段编辑消息
  async sendStreamChunk(userId: string, chunk: StreamEvent): Promise<void> {
    if (chunk.type === 'text_delta') {
      await this.bot.telegram.editMessageText(
        userId, this.lastMessageId, undefined, this.accumulatedText
      );
    }
  }
}
```

## 3.4 Web 通道（WebSocket）
```typescript
// src/gateway/channels/web.gateway.ts
export class WebChannel extends BaseChannel {
  readonly type = 'web';
  readonly name = 'Web Chat';
  private connections: Map<string, ServerWebSocket> = new Map();

  async initialize(): Promise<void> {
    Bun.serve({
      port: config.webSocketPort,
      fetch: (req, server) => server.upgrade(req) ? undefined : new Response('Upgrade failed', { status: 500 }),
      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, msg) => this.handleWsMessage(ws, msg),
        close: (ws) => this.handleClose(ws),
      },
    });
  }
}
```

## 3.5 消息路由器
```typescript
// src/gateway/message-router.ts
export class MessageRouter {
  private readonly controller: CentralController;

  async route(message: BotMessage): Promise<void> {
    // 统一进入 CentralController
    await this.controller.handleIncomingMessage(message);
  }
}
```

## 3.6 通道管理器
```typescript
export class ChannelManager {
  private readonly channels: Map<ChannelType, IChannel> = new Map();

  async registerChannel(channel: IChannel): Promise<void> {
    await channel.initialize();
    this.channels.set(channel.type, channel);
  }

  getChannel(type: ChannelType): IChannel | undefined {
    return this.channels.get(type);
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.channels.values()].map(c => c.shutdown()));
  }
}
```
