# 第5章 实时流式体验
> **本章目标**：设计跨平台的实时流式输出架构，让用户在飞书、Telegram、Web 上都能获得"打字机"般的实时响应体验。
## 5.1 流式架构
流式输出采用三层管道架构：
```plaintext
Claude API (SSE) → StreamProcessor → ChannelAdapter → 用户
```

```typescript
// src/kernel/agents/stream-handler.ts
export class StreamHandler {
  async processStream(
    response: AsyncIterable<StreamEvent>,
    adapters: ChannelStreamAdapter[]
  ): Promise<string> {
    let fullContent = '';
    const buffer = new StreamBuffer({ flushIntervalMs: 100 });

    for await (const event of response) {
      switch (event.type) {
        case 'content_block_delta':
          fullContent += event.delta.text;
          buffer.append(event.delta.text);
          if (buffer.shouldFlush()) {
            const chunk = buffer.flush();
            await Promise.all(adapters.map(a => a.sendChunk(chunk)));
          }
          break;
        case 'content_block_stop':
          const remaining = buffer.flush();
          if (remaining) {
            await Promise.all(adapters.map(a => a.sendChunk(remaining)));
          }
          await Promise.all(adapters.map(a => a.sendDone(fullContent)));
          break;
        case 'message_stop':
          break;
      }
    }
    return fullContent;
  }
}
```

## 5.2 飞书流式实现
飞书采用“卡片更新”模式实现流式效果：
1. 收到用户消息后，立即发送一张“思考中...”卡片
1. 随着 AI 输出，不断更新卡片内容（PATCH API）
1. 完成后发送最终卡片（带操作按钮）
```typescript
export class FeishuStreamAdapter implements ChannelStreamAdapter {
  private cardMessageId?: string;
  private accumulatedText = '';
  private updateCount = 0;

  async sendChunk(text: string): Promise<void> {
    this.accumulatedText += text;
    this.updateCount++;

    if (!this.cardMessageId) {
      // 首次：创建流式卡片
      this.cardMessageId = await this.feishu.createStreamCard(
        this.chatId, this.accumulatedText
      );
    } else {
      // 后续：更新卡片内容
      await this.feishu.updateCard(this.cardMessageId, this.accumulatedText);
    }
  }

  async sendDone(finalText: string): Promise<void> {
    // 发送最终卡片（带操作按钮）
    await this.feishu.updateCard(this.cardMessageId!, finalText, {
      showActions: true,
      actions: ['复制', '重新生成', '继续追问'],
    });
  }
}
```

## 5.3 Telegram 流式实现
Telegram 采用“编辑消息”模式，需要控制更新频率以避免 API 限流（每分钟 30 次）。
## 5.4 Web WebSocket 流式实现
Web 通道通过 WebSocket 直接推送原始 token，延迟最低。
## 5.5 流式消息协议
```typescript
export interface StreamProtocol {
  type: 'stream_start' | 'text_delta' | 'tool_start' | 'tool_result'
      | 'thinking' | 'error' | 'stream_end';
  data: {
    text?: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    error?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };
  metadata: {
    messageId: string;
    sequenceNumber: number;
    timestamp: number;
  };
}
```

## 5.6 防抖与节流策略


| 通道 | 策略 | 间隔 | 原因 |
| --- | --- | --- | --- |
| 飞书 | 节流 | 300ms | 卡片 PATCH API 限流 |
| Telegram | 节流 | 2000ms | editMessage 每分钟 30 次限制 |
| Web | 不限制 | 实时 | WebSocket 直接推送 |
