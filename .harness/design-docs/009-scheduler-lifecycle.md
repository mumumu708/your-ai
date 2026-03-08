# DD-009: Scheduler 生命周期与持久化

- **状态**: Implemented
- **作者**: Agent
- **创建日期**: 2026-03-07
- **最后更新**: 2026-03-08

## 背景

定时任务系统（`docs/07-scheduled-tasks.md`）核心调度模块已实现，但存在两个缺口：

1. **Scheduler 未接入执行链路** — `CentralController` 创建了 `Scheduler` 但从未调用 `setExecutor()` / `start()`，导致注册的 job 永远不会被触发执行。
2. **Job 无持久化** — 纯内存 `Map`，进程重启后所有定时任务丢失。

## 目标

1. Scheduler 在 Gateway 启动时自动初始化（加载、设置 executor、start），关闭时持久化并停止。
2. Job 持久化到本地 JSON 文件，进程重启后恢复。
3. 定时任务触发时通过 `executeChatPipeline` 生成 AI 回复，并通过对应 channel 推送给用户。

## 非目标

- 不涉及分布式调度或多进程锁。
- 不涉及 cron 解析逻辑变更。
- ~~不涉及 job 管理 API（查看/暂停/恢复/取消已有的 REST 接口）。~~ → 已在 2026-03-08 补齐取消/查看功能，见下方"后续扩展"。

## 方案

### 概述

引入 `JobStore` 类做 JSON 文件持久化；在 `Scheduler` 中集成 store，关键操作后自动持久化；在 `CentralController` 新增 `initScheduler()` / `stopScheduler()` 方法，executor 回调走 chat pipeline + channel 推送；Gateway 启动/关闭时调用。

### 详细设计

#### JobStore

- 构造接受可选 `filePath`（默认 `data/scheduler/jobs.json`，可通过 `SCHEDULER_STORE_PATH` 环境变量覆盖）
- `load(): ScheduledJob[]` — 读 JSON 文件，不存在返回空数组
- `save(jobs): void` — 过滤 `cancelled` 后写入，自动创建目录
- 选用本地 JSON：与 workspace-manager 等现有模式一致，job 写入低频无并发问题

#### Scheduler 变更

- 构造接受可选 `store?: JobStore`
- `ScheduleConfig` 新增 `channel?: ChannelType`
- `ScheduledJob` 新增 `channel: ChannelType`（默认 `'api'`）
- `register/pause/resume/cancel/executeJob` 后调用 `persistJobs()`
- 新增 `loadJobs()` 从 store 加载填充内存 Map

#### CentralController 变更

- `initScheduler()`: 加载 jobs → 设置 executor → start
  - executor: 构造 `BotMessage` → resolveSession → 确保 workspace/configLoader → executeChatPipeline → channel.sendMessage
- `stopScheduler()`: stop + persistJobs

#### Gateway 变更

- `setChannelResolver()` 之后调用 `controller.initScheduler()`
- shutdown 回调中调用 `controller.stopScheduler()`

### 影响范围

| 文件 | 操作 |
|------|------|
| `src/kernel/scheduling/scheduler.ts` | 修改 |
| `src/kernel/scheduling/job-store.ts` | 新建 |
| `src/kernel/scheduling/index.ts` | 修改 |
| `src/kernel/central-controller.ts` | 修改 |
| `src/gateway/index.ts` | 修改 |
| `src/kernel/scheduling/job-store.test.ts` | 新建 |
| `src/kernel/scheduling/scheduler.test.ts` | 修改 |

### 后续扩展: 定时任务取消/查看 (2026-03-08)

原"非目标"中的 job 管理能力已补齐：

#### 意图识别

- `SCHEDULE_PATTERNS` 正则清空，定时任务意图完全由 LLM 分类
- `UnifiedClassifyResult` 新增 `subIntent` 字段，LLM 在 `taskType: "scheduled"` 时输出 `subIntent: "create" | "cancel" | "list"`
- `handleScheduledTask` 按 `subIntent` 分流到创建 / 取消 / 列表逻辑

#### ScheduleCancelManager

- 新模块 `src/kernel/scheduling/schedule-cancel-manager.ts`
- 两步交互: `startCancelFlow()` 列出活跃任务 → 用户回复数字序号 → `processSelection()` 取消对应 job
- 支持"算了"/"取消"/"0" 退出操作，5 分钟超时自动清理 pending 状态
- `CentralController.handleIncomingMessage` 在分类前拦截 pending 选择状态

#### 影响范围

| 文件 | 操作 |
|------|------|
| `src/shared/classifier/classifier-types.ts` | 修改（新增 subIntent） |
| `src/kernel/classifier/task-classifier.ts` | 修改（清空 SCHEDULE_PATTERNS，更新 LLM prompt） |
| `src/kernel/scheduling/schedule-cancel-manager.ts` | 新建 |
| `src/kernel/scheduling/index.ts` | 修改（导出新模块） |
| `src/kernel/central-controller.ts` | 修改（接入 cancel/list 分流） |

## 备选方案

- **SQLite 持久化**: 更重，当前 job 数量少且写入低频，JSON 足够。
- **将 executor 逻辑放在 Scheduler 内**: 违反分层，Scheduler 不应直接依赖 session/channel。

## 验收标准

- [x] `bun test` 全部通过
- [x] `bun run typecheck` 通过
- [x] `bun run check:arch` 通过
- [x] JobStore save/load 往返正确
- [x] cancelled job 被 save 过滤
- [x] channel 字段默认为 'api'，可显式设置
