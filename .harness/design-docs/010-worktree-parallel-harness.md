# DD-010: Worktree 并行 Harness 系统

- **状态**: Draft
- **创建日期**: 2026-03-08

## 背景

当前 harness 任务通过 `HarnessMutex` 全局串行执行（`central-controller.ts:355`）。所有 `claude --print` 进程共享项目根目录作为 cwd，无法并行——两个进程同时修改文件会产生冲突。

Phase 5 设计文档中已提出"git worktree 隔离并行任务"的思路，本文档详细设计实现方案。

## 目标

1. 支持最多 5 个 harness 任务并行执行
2. 每个任务在独立 git worktree 中工作，互不干扰
3. 任务完成后自动推送分支、清理 worktree
4. 多任务修改同一文件时，通过有序合并 + Claude 辅助解决冲突

## 非目标

- 任务间的实时协调（如 Agent A 通知 Agent B 自己改了什么）
- 跨任务的共享状态（每个任务完全独立）
- Worktree 池化复用（按需创建、用完销毁，不预分配）

## 方案

### 概述

用 `WorktreePool` 替代 `HarnessMutex`。每个 harness 任务启动时，WorktreePool 从 main 分支创建一个 git worktree + 新分支，将 worktree 路径作为 cwd 传给 claude 进程。任务完成后推送分支、创建 PR、清理 worktree。

### 详细设计

#### 1. WorktreePool

```typescript
// src/kernel/sessioning/worktree-pool.ts

interface WorktreeSlot {
  id: string;               // 唯一标识，如 "harness-1709884800-abc"
  branch: string;           // 分支名，如 "agent/fix/telegram-bug"
  worktreePath: string;     // 绝对路径，如 "/project/.worktrees/harness-xxx"
  taskId: string;           // 关联的 task ID
  createdAt: number;
}

interface WorktreePoolConfig {
  maxConcurrent?: number;   // 默认 5
  basePath?: string;        // worktree 存放目录，默认 `${projectRoot}/.worktrees`
  timeoutMs?: number;       // 单任务最大时长，默认 30 分钟
}

class WorktreePool {
  private slots: Map<string, WorktreeSlot>;
  private readonly maxConcurrent: number;

  // 为任务分配一个 worktree，返回 worktree 路径
  async acquire(taskId: string, branchName: string): Promise<WorktreeSlot>

  // 任务完成后清理 worktree
  async release(slotId: string): Promise<void>

  // 带自动获取/释放的便捷方法
  async run<T>(taskId: string, branchName: string, fn: (slot: WorktreeSlot) => Promise<T>): Promise<T>
}
```

**acquire 流程**：

```
1. 检查并发数 < maxConcurrent，否则排队等待（复用 HarnessMutex 的 waiter 模式）
2. git worktree add .worktrees/{id} -b {branchName} main
3. 记录 slot 信息
4. 返回 slot（含 worktreePath）
```

**release 流程**：

```
1. git worktree remove .worktrees/{id} --force
2. 从 slots 中移除
3. 如有排队任务，唤醒下一个
```

#### 2. CentralController 集成

替换 `handleIncomingMessage` 中的 `harnessMutex.run()`：

```typescript
// 现在（串行）
if (taskType === 'harness') {
  result = await this.harnessMutex.run(() =>
    this.sessionSerializer.run(sessionKey, () => this.orchestrate(task)),
  );
}

// 改为（并行 worktree）
if (taskType === 'harness') {
  result = await this.sessionSerializer.run(sessionKey, () => this.orchestrate(task));
  // harness 的并行隔离移到 handleHarnessTask 内部
}
```

#### 3. handleHarnessTask 改造

```typescript
private async handleHarnessTask(task: Task): Promise<TaskResult> {
  if (!isAdminUser(task.message.userId)) {
    task.type = 'chat';
    return this.executeChatPipeline(task);
  }

  // 从消息内容生成分支名（可用 LLM 简要摘要或规则提取）
  const branchName = await this.generateBranchName(task);

  return this.worktreePool.run(task.id, branchName, async (slot) => {
    this.logger.info('Harness 任务分配 worktree', {
      taskId: task.id,
      branch: slot.branch,
      worktreePath: slot.worktreePath,
    });

    return this.executeChatPipeline(task, {
      cwdOverride: slot.worktreePath,
      forceComplex: true,
    });
  });
}
```

#### 4. 分支命名

基于 `TaskClassifier` 的 harness 子类型自动生成：

```
消息: "修复 telegram 超时 bug"  → agent/fix/telegram-timeout-{short-hash}
消息: "给 memory 加缓存"        → agent/feat/memory-cache-{short-hash}
消息: "重构 classifier"          → agent/refactor/classifier-{short-hash}
```

短 hash 用时间戳或随机串，避免分支名冲突。

#### 5. Worktree 生命周期

```
任务开始
  │
  ├─ WorktreePool.acquire()
  │    └─ git worktree add .worktrees/{id} -b {branch} main
  │
  ├─ claude --print -p "..." (cwd = worktree path)
  │    └─ Agent 在 worktree 内执行：编辑代码 → check:all → git commit → git push
  │
  ├─ 任务完成（Agent 已 push 分支 + 创建 PR）
  │
  └─ WorktreePool.release()
       └─ git worktree remove .worktrees/{id}
```

**超时保护**：任务超过 30 分钟未完成 → 强制 release worktree（kill claude 进程 + 清理）。

**异常保护**：进程崩溃 → finally 块保证 release。启动时扫描 `.worktrees/` 清理残留。

#### 6. 冲突合并策略

当两个并行任务改了同一文件，合并到 main 时可能冲突：

```
场景：
  Agent A: agent/fix/telegram-bug    → 改了 src/gateway/channels/telegram.ts
  Agent B: agent/feat/telegram-retry → 也改了 src/gateway/channels/telegram.ts

  Agent A 先合并到 main ✅
  Agent B 合并时冲突 ❌
```

**合并流程**（由管理员触发或自动）：

```
1. 检测差异
   git diff main...{branch} --name-only
   与已合并的其他 harness 分支对比是否有文件交集

2. 无冲突 → 直接合并（管理员 review PR 后 merge）

3. 有冲突 → 自动 rebase 尝试
   git rebase main (在 worktree 内)

4. rebase 失败 → Claude 辅助解决
   - 提取冲突文件和冲突标记
   - 调用 claude 分析冲突语义，生成解决方案
   - 应用解决方案后运行 check:all 验证
   - 推送更新的分支

5. 验证通过 → 通知管理员 review
   验证失败 → 通知管理员需要人工介入
```

**实现**：冲突解决不在 WorktreePool 中，而是作为一个独立的 harness 任务触发（"帮我合并 agent/feat/xxx 分支"），复用已有的 claude 工程能力。

#### 7. .gitignore 更新

```gitignore
# Harness worktrees
.worktrees/
```

### 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/sessioning/worktree-pool.ts` | **新增** — WorktreePool 实现 |
| `src/kernel/sessioning/index.ts` | 导出 WorktreePool |
| `src/kernel/central-controller.ts` | HarnessMutex → WorktreePool |
| `src/kernel/sessioning/harness-mutex.ts` | **保留** — WorktreePool 内部复用其 waiter 逻辑做排队 |
| `.gitignore` | 添加 `.worktrees/` |
| `.harness/architecture.md` | 更新 sessioning 模块描述 |

### 不变的部分

- `ClaudeAgentBridge` — 已经通过 `cwd` 参数支持任意目录，无需修改
- `executeChatPipeline` — 已经通过 `cwdOverride` 支持，无需修改
- CLAUDE.md 中的 git 工作流 — Agent 在 worktree 中的操作与在主仓库中完全一致
- 流式输出、session 管理 — 不受 worktree 影响

## 备选方案

### A. Docker 容器隔离

每个 harness 任务在独立容器中执行。

**否决原因**：过重。需要构建镜像、管理容器生命周期、处理文件系统映射。git worktree 是轻量级的原生 git 特性，几乎零开销。

### B. 保持 HarnessMutex 串行 + 异步队列

用队列管理 harness 任务，仍然一个接一个执行，但管理员可以批量提交。

**否决原因**：不解决核心问题——串行执行慢。5 个独立任务串行可能需要 1 小时，并行可能 15 分钟。

### C. 在同一目录中交替切换分支

不用 worktree，每个任务 stash → checkout → 执行 → stash → 切回。

**否决原因**：无法真正并行，本质还是串行。而且 stash 操作容易出错。

## 验收标准

- [ ] WorktreePool 支持最多 5 个并发 worktree
- [ ] 每个 harness 任务在独立 worktree 中执行，互不影响
- [ ] 任务完成后 worktree 自动清理
- [ ] 超时任务被正确终止和清理
- [ ] 进程异常退出后，启动时能清理残留 worktree
- [ ] 成功完成至少 1 次 2 个并行 harness 任务
- [ ] 并行任务各自独立 push 分支、创建 PR
- [ ] `bun run check:all` 在 worktree 内正常运行
- [ ] 冲突场景下 Claude 能辅助解决并通过 check:all

## 参考

- Harness Engineering Design v4: Phase 5 (§7.2)
- DD-003: Harness Engineering 系统
- git worktree 文档: https://git-scm.com/docs/git-worktree
