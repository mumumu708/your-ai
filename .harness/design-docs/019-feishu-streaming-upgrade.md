# DD-019: 飞书卡片流式处理升级

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-12
- **最后更新**: 2026-04-12
- **上游**: [DD-004](004-gateway-channels.md)、[DD-011](011-architecture-upgrade-v2.md)

## 背景

当前飞书流式处理的问题：**返回内容太多**。Claude Code 的所有输出（tool 调用过程、中间推理、完整工具结果）都推送到飞书卡片，导致卡片内容冗长，用户体验差。

参考 Agentara 的三阶段模式：
1. **占位**：立即回复 "Thinking..." 卡片，拿到 thread_id / message_id，建立 session 绑定
2. **流式增量**：只推 assistant 角色的文本消息，tool 调用只显示状态摘要
3. **最终更新**：streaming=false 的一次性最终渲染，可清除中间状态

## 目标

1. 占位先行：用户发消息后立即看到"已开始处理"反馈
2. 内容过滤：只推送用户需要看的内容，屏蔽中间过程噪声
3. 工具状态摘要：tool 调用显示一行状态，不显示完整输入输出
4. 最终渲染：流结束后做一次干净的最终更新

## 方案

### 1. 三阶段流式协议

```
阶段 1: 占位（Placeholder）
├─ 时机：dispatch 之后、agent 执行之前
├─ 内容："💭 Thinking..."
├─ 目的：
│   ├─ 用户立即看到反馈
│   ├─ 拿到 messageId（后续增量更新的目标）
│   └─ 拿到 threadId（session ↔ thread 绑定）
└─ 返回：PlaceholderResult { messageId, threadId }

阶段 2: 流式增量（Streaming）
├─ 时机：agent 执行过程中
├─ 过滤规则：
│   ├─ text_delta    → ✅ 推送（聚合到 content buffer）
│   ├─ tool_start    → ✅ 推送（一行摘要："🔧 正在搜索记忆..."）
│   ├─ tool_result   → ❌ 不推送（内容可能很长）
│   ├─ thinking      → ❌ 不推送
│   └─ error         → ✅ 推送（错误摘要）
├─ 更新方式：updateCard(messageId, content, { streaming: true })
└─ 节流：300ms（飞书 API 限流）

阶段 3: 最终更新（Finalize）
├─ 时机：agent 执行完成
├─ 内容：最终回复文本（清除中间状态行）
├─ 更新方式：updateCard(messageId, finalContent, { streaming: false })
└─ 附加：可选的操作按钮（👍/👎 反馈等）
```

### 2. Stream Event 过滤器

```typescript
// src/kernel/streaming/stream-content-filter.ts

interface FilteredStreamEvent {
  type: 'content' | 'status' | 'error' | 'done';
  text: string;
  append: boolean;  // true=追加到现有内容, false=替换状态行
}

class StreamContentFilter {
  private toolStatusLine: string | null = null;

  filter(event: StreamEvent): FilteredStreamEvent | null {
    switch (event.type) {
      case 'text_delta':
        // 清除之前的工具状态行，追加新文本
        this.toolStatusLine = null;
        return { type: 'content', text: event.content, append: true };

      case 'tool_start':
        // 只显示一行摘要
        const summary = this.summarizeToolStart(event);
        this.toolStatusLine = summary;
        return { type: 'status', text: summary, append: false };

      case 'tool_result':
        // 不推送完整结果，但清除状态行
        this.toolStatusLine = null;
        return null;

      case 'thinking':
        // 不推送内部推理
        return null;

      case 'error':
        return { type: 'error', text: `⚠️ ${event.content}`, append: true };

      case 'done':
        return { type: 'done', text: '', append: false };

      default:
        return null;
    }
  }

  private summarizeToolStart(event: StreamEvent): string {
    const toolName = event.metadata?.toolName as string || 'tool';
    const toolSummaries: Record<string, string> = {
      'memory_search': '🔍 正在搜索记忆...',
      'memory_store': '💾 正在保存记忆...',
      'skill_view': '📖 正在加载 Skill...',
      'session_search': '🔍 正在搜索历史会话...',
      'web_search': '🌐 正在搜索网络...',
      'Read': '📄 正在读取文件...',
      'Write': '✏️ 正在写入文件...',
      'Edit': '✏️ 正在编辑文件...',
      'Bash': '⚡ 正在执行命令...',
      'Glob': '🔍 正在搜索文件...',
      'Grep': '🔍 正在搜索内容...',
    };
    return toolSummaries[toolName] || `🔧 正在使用 ${toolName}...`;
  }
}
```

### 3. FeishuStreamAdapter 重构

```typescript
// src/gateway/channels/adapters/feishu-stream-adapter.ts

class FeishuStreamAdapter implements ChannelStreamAdapter {
  private messageId: string;         // 占位卡片的 messageId
  private contentBuffer: string = '';
  private statusLine: string | null = null;
  private filter: StreamContentFilter;
  private throttleTimer: Timer | null = null;
  private pendingUpdate: boolean = false;

  constructor(
    private cardKit: CardKitClient,
    private userId: string,
    messageId: string,
  ) {
    this.messageId = messageId;
    this.filter = new StreamContentFilter();
  }

  async sendToken(event: StreamEvent): Promise<void> {
    const filtered = this.filter.filter(event);
    if (!filtered) return;

    switch (filtered.type) {
      case 'content':
        this.contentBuffer += filtered.text;
        this.statusLine = null;
        break;
      case 'status':
        this.statusLine = filtered.text;
        break;
      case 'error':
        this.contentBuffer += '\n' + filtered.text;
        break;
    }

    this.scheduleUpdate();
  }

  async completeStream(): Promise<void> {
    // 最终更新：只保留正文，清除状态行
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    await this.cardKit.updateCard(this.messageId, {
      content: this.contentBuffer.trim(),
      streaming: false,
      // 可选：附加反馈按钮
    });
  }

  private scheduleUpdate(): void {
    if (this.throttleTimer) {
      this.pendingUpdate = true;
      return;
    }

    this.doUpdate();
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.pendingUpdate) {
        this.pendingUpdate = false;
        this.doUpdate();
      }
    }, 300); // 300ms 节流
  }

  private async doUpdate(): Promise<void> {
    // 组合显示：正文 + 状态行（如果有）
    let display = this.contentBuffer;
    if (this.statusLine) {
      display += '\n\n' + this.statusLine;
    }

    await this.cardKit.updateCard(this.messageId, {
      content: display,
      streaming: true,
    });
  }
}
```

### 4. 占位 + Thread 绑定

```typescript
// src/kernel/central-controller.ts 中的执行流程

async executeChatPipeline(task: Task): Promise<TaskResult> {
  const session = task.session;

  // ── 阶段 1: 占位 ──
  const placeholder = await this.sendPlaceholder(session, '💭 Thinking...');

  // 绑定 threadId → sessionId（飞书回复后才能拿到 threadId）
  if (placeholder.threadId && !session.threadId) {
    session.threadId = placeholder.threadId;
    // 持久化绑定关系
    this.sessionStore.updateThreadBinding(session.id, placeholder.threadId);
  }

  // ── 阶段 2: 创建流式适配器 ──
  const streamAdapter = this.createStreamAdapter(session.channel, placeholder.messageId);

  // ── 阶段 3: 执行 ──
  try {
    const result = await this.gateway.handle({
      ...task,
      streamCallback: (event) => streamAdapter.sendToken(event),
    });

    // ── 阶段 4: 最终更新 ──
    await streamAdapter.completeStream();

    return result;
  } catch (error) {
    // 错误时更新卡片为错误信息
    await streamAdapter.sendToken({
      type: 'error',
      content: error instanceof Error ? error.message : '处理失败',
    });
    await streamAdapter.completeStream();
    throw error;
  }
}

private async sendPlaceholder(session: Session, content: string) {
  const channel = this.channelManager.getChannel(session.channel);
  return channel.sendMessage(session.userId, content, {
    replyTo: session.threadId, // 如果已有 thread，在 thread 内回复
    streaming: true,           // 标记为流式卡片
  });
}
```

### 5. 各通道适配

| 通道 | 占位 | 流式增量 | 最终更新 | 节流 |
|------|------|---------|---------|------|
| 飞书 | 发送流式卡片 | updateCard（内容过滤） | updateCard(streaming=false) | 300ms |
| Telegram | 发送消息 | editMessage（内容过滤） | editMessage（最终） | 2000ms |
| Web | 不需要占位 | WebSocket push（全量事件） | done 事件 | 无 |

Web 通道不需要过滤 — 前端可以自行决定展示哪些事件。飞书和 Telegram 因为更新 API 有限流，需要在 harness 层过滤和节流。

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/streaming/stream-content-filter.ts` | 新增 — 事件过滤器 |
| `src/gateway/channels/adapters/feishu-stream-adapter.ts` | 重构 — 集成过滤器、三阶段协议 |
| `src/gateway/channels/adapters/telegram-stream-adapter.ts` | 同步更新 — 集成过滤器 |
| `src/kernel/central-controller.ts` | 修改 — 占位先行、thread 绑定 |
| `src/kernel/streaming/stream-handler.ts` | 修改 — 适配新的过滤流程 |

## 验收标准

- [ ] 用户发消息后立即看到 "Thinking..." 占位卡片
- [ ] Tool 调用只显示一行状态摘要，不显示完整输入输出
- [ ] Thinking/内部推理不推送到卡片
- [ ] 最终更新清除中间状态行，只保留正文
- [ ] Thread ID 绑定在占位阶段完成
- [ ] 飞书 300ms 节流正常工作
- [ ] `bun run check:all` 通过

## 参考

- Agentara — 三阶段流式协议（占位 → 增量 → 最终）
- 当前 `src/gateway/channels/adapters/feishu-stream-adapter.ts` — 现有实现基础
- [DD-004](004-gateway-channels.md) — 飞书通道原始设计
