# DD-021: 飞书 Placeholder + ThreadId 绑定（Tier 3）

- **状态**: Planned（待架构升级 V2 稳定后实施）
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-12
- **最后更新**: 2026-04-12
- **上游**: [DD-019](019-feishu-streaming-upgrade.md)、[DD-020](020-integration-test-plan.md)

## 背景

DD-019 设计了飞书流式的"占位先行 + thread 绑定"能力，但当前代码中**没有任何实现支点**：

- 无 `sendPlaceholder()` 方法
- 无 `session.threadId` 字段
- 无 `updateThreadBinding()` 存储方法
- FeishuStreamAdapter 只管理 cardId，不参与 session 管理

当前飞书流式已经可以工作（adapter 自己创建卡片 → 流式更新 → 关闭），只是没有"先占位后流式"的体验优化和 thread 绑定。

## 需要开发的新代码

| 模块 | 变更 | 详情 |
|------|------|------|
| **CentralController** | 新增 `sendPlaceholder()` | 在 executeChatPipeline 最前面调用，拿到 messageId/threadId |
| **Session 类型** | 新增 `threadId?: string` | `src/shared/tasking/task.types.ts` |
| **SessionStore** | 新增 `updateThreadBinding()` 或 sessions 表加 thread_id 列 | 持久化 threadId |
| **SessionManager** | threadId 写入逻��� | resolveSession 或 addMessage 时更新 |
| **FeishuStreamAdapter** | 支持 `existingCardId` | 跳过 onStreamStart 中的 createStreamingCard，复用已有卡片 |
| **飞书 Channel** | 暴露 `sendPlaceholder()` | 返回 messageId + threadId |

## 集成测试场景（DD-020 Tier 3）

| 编号 | 场景 | 验证点 |
|------|------|--------|
| FS-12 | placeholder 先发 + adapter 复用 cardId | 执行前发占位卡片 → adapter 更新复用同一 cardId |
| FS-13 | threadId 持久化 | threadId 写入 session → 同 session 后续消息用同一 threadId |
| FS-14 | 节流参数配置化 | controller 从 config 读 throttleMs 传入 adapter |

## 实施时机

架构升级 V2 的 Phase A + Phase B 全部完成并稳定后再实施。预计作为独立 PR。

## 参考

- DD-019 `019-feishu-streaming-upgrade.md` — 三阶段协议的完整设计
- Agentara 的 "先占位、后流式增量更新" 模式
- 当前 FeishuStreamAdapter API：`src/gateway/channels/adapters/feishu-stream-adapter.ts`
