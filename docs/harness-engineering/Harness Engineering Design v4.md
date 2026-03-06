# Your-AI Harness Engineering 系统设计与落地方案 v2

## 0. 核心问题与解决思路

### 0.1 双重角色

Your-AI 中 Claude Code 承担两个角色：

| 维度       | 用户服务                                | 工程开发（Harness）          |
| ---------- | --------------------------------------- | ---------------------------- |
| 触发者     | 终端用户                                | 管理员                       |
| 职责       | 问答、日常任务、技能执行                | 新增能力、修复 Bug、架构调整 |
| 上下文来源 | AIEOS 协议（SOUL/IDENTITY/USER/AGENTS） | 架构文档、编码规范、测试结果 |
| 输出       | 自然语言回复、任务执行结果              | 代码变更、文档更新           |

三份原始计划的共同盲区：都试图将 `config/AGENTS.md` 改造为 Harness 入口。但 `AGENTS.md` 是 AIEOS 协议的一部分——用户首次到来时复制到用户空间，定义的是"如何与用户交互"，不是"如何改代码"。

### 0.2 两条设计原则

**原则 1：user-space 移出项目目录。**

现状 `user-space/` 在项目内部，Claude Code 子进程以 user-space 为 cwd 时，会向上遍历到项目根目录并加载 `CLAUDE.md`，导致 Harness 工程规范泄漏到用户对话中。将 user-space 移到项目外（如 `/data/your-ai-users/`），从物理路径上隔断这条泄漏通道。

**原则 2：管理员与普通用户走基本一致的路径。**

管理员也通过 Feishu/Telegram/Web 对话触发工程任务，不需要 SSH 到服务器用终端。路径完全复用现有 Channel → Gateway → Bridge → `claude --print` 的链路。

### 0.3 方案：cwd 隔离 + 任务类型切换

**核心理念：管理员首先是用户，其次才是管理员。**

管理员拥有和普通用户完全一样的 user-space（SOUL.md、IDENTITY.md、记忆数据等）。只有当消息被识别为工程任务（harness 类型）且发送者是管理员时，才切换 cwd 到项目根。

```
任何消息 → TaskClassifier 判断意图
  ├── chat / scheduled / automation / system → cwd = user-space（所有用户一视同仁）
  └── harness                               → 检查是否管理员
        ├── 是管理员 → cwd = 项目根（加载 CLAUDE.md + Harness）
        └── 非管理员 → 静默降级为 chat（正常回答，不提示"无权限"）
```

具体示例：

```
管理员: "明天天气怎么样"         → chat    → cwd = 管理员的 user-space → 普通回答
管理员: "帮我修下 memory 的 bug"  → harness → cwd = 项目根 → 工程模式
管理员: "记住我喜欢简洁的回复"    → chat    → cwd = 管理员的 user-space → 写入管理员的 IDENTITY
普通用户: "帮我修下 memory 的 bug" → harness → 非管理员 → 降级 chat → 普通回答
```

Claude Code 的 CLAUDE.md 加载机制是从 cwd 向上遍历目录树——user-space 在项目外，不会碰到 CLAUDE.md；项目根则自动加载。无需 `--append-system-prompt`，无需额外 token 开销。

```
/opt/your-ai/                    ← harness 任务 cwd
├── CLAUDE.md                    ← 自动加载，指向 .harness/
├── .harness/                    ← Harness 工程规范
├── config/                      ← AIEOS 协议（全局默认模板）
├── src/
└── ...

/data/your-ai-users/             ← 所有用户的 cwd（包括管理员的非 harness 对话）
├── admin-001/                   ← 管理员也有自己的完整 user-space
│   └── memory/
│       ├── SOUL.md              ← 管理员的个性化配置
│       ├── IDENTITY.md
│       ├── USER.md
│       └── AGENTS.md
├── user-002/
├── user-003/
└── ...
```

### 0.4 Harness 任务识别

分流依赖两个判断：**TaskClassifier 识别意图** + **管理员身份校验**。

**TaskClassifier 扩展**：

项目已有 `TaskClassifier`（`src/kernel/classifier/task-classifier.ts`），当前支持 `chat / scheduled / automation / system` 四种类型。扩展为支持 `harness` 类型：

```typescript
// TaskClassifier 的 harness 判定标准（注入到分类 prompt 中）
// harness 类型特征：
// - 涉及代码修改（修 bug、加功能、重构）
// - 涉及项目基础设施（跑测试、查架构、看覆盖率）
// - 涉及文档维护（更新设计文档、查过期文档）
// - 涉及部署和运维（查日志、重启服务、查状态）
//
// 不属于 harness：
// - 关于编程概念的知识问答（"什么是 TypeScript 泛型"）
// - 管理员的日常对话（"明天天气"、"帮我写封邮件"）
// - 管理员的个性化设置（"记住我的偏好"）
```

**Bridge 调用逻辑**：

```typescript
// .env
ADMIN_USER_IDS=feishu:xxx,telegram:yyy

// Bridge 逻辑
const taskType = await taskClassifier.classify(message);
const isHarnessTask = taskType === 'harness' && isAdmin(userId);

const cwd = isHarnessTask
  ? process.env.PROJECT_ROOT       // 项目根 → 加载 CLAUDE.md + Harness
  : getUserSpacePath(userId);       // 所有用户（包括管理员）的日常对话

if (isHarnessTask) {
  // 工程模式下仍然注入管理员的人格文件——AI 助手的根本不应因模式切换而消失
  const userSpace = getUserSpacePath(userId);
  const soul = readFileSync(path.join(userSpace, 'memory/SOUL.md'), 'utf-8');
  const identity = readFileSync(path.join(userSpace, 'memory/IDENTITY.md'), 'utf-8');
  spawn('claude', [
    '--print', '-p', prompt,
    '--append-system-prompt', `${soul}\n${identity}`
  ], { cwd });
} else {
  spawn('claude', ['--print', '-p', prompt], { cwd });
}
```

这样 harness 模式下同时加载两层上下文：

- 通过 cwd → CLAUDE.md + .harness/\* （工程规范）
- 通过 --append-system-prompt → SOUL.md + IDENTITY.md（助手人格）

**误判缓解**：

| 误判方向       | 场景                       | 影响                             | 缓解                                                           |
| -------------- | -------------------------- | -------------------------------- | -------------------------------------------------------------- |
| chat → harness | 管理员闲聊被当成工程任务   | 回答带不必要的工程口吻           | CLAUDE.md 提示：如果用户意图看起来不是工程任务，按普通对话回答 |
| harness → chat | 管理员想做开发但没识别出来 | 在 user-space 执行，无法修改代码 | 管理员可以重述更明确（"用代码修复..."）                        |

误判的成本都不高——worst case 就是回答的语气/上下文不太对，不会造成数据损坏或安全问题。

### 0.5 Headless 模式的局限与缓解

管理员走 `--print` headless 模式，没有交互式确认、`/memory`、subagent 等完整能力。缓解策略：

| 局限            | 缓解                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| 无交互确认      | 复杂任务先输出 plan，管理员确认后逐步执行                                         |
| 无 subagent     | Agent 自主运行 bash 命令（check:all、git 等），不需要 subagent                    |
| 上下文窗口有限  | CLAUDE.md 做目录（~80行），深层文档按需引用                                       |
| 无 /memory 命令 | Harness 文档版本化在 git 中；SOUL.md/IDENTITY.md 通过 --append-system-prompt 注入 |

---

## 1. 总体架构

### 1.1 Harness Engineering 四大支柱

```
          ┌──────────────────────────────────────┐
          │      CLAUDE.md（目录入口，~80 行）      │
          │   harness 任务 cwd = 项目根 → 自动加载  │
          │   其他任务 cwd = user-space → 不加载    │
          └──────────────┬───────────────────────┘
                         │
     ┌───────────────────┼───────────────────┐
     │                   │                   │
     ▼                   ▼                   ▼
 ┌────────┐       ┌──────────┐        ┌──────────────┐
 │文档体系 │       │ 架构护栏  │        │ 本地质量闭环  │
 │.harness/│       │ scripts/ │        │ check:all    │
 └────┬───┘       └────┬─────┘        └──────┬───────┘
      └────────────────┼────────────────────┘
                       ▼
              ┌────────────────┐
              │ 编排与质量门控  │
              └────────────────┘
```

### 1.2 分阶段路线图

```
Phase 0 (第 1 周)     user-space 迁移 + 管理员识别 + TaskClassifier 扩展
Phase 1 (第 1-2 周)   文档基础（CLAUDE.md + .harness/）
Phase 2 (第 2-3 周)   本地质量闭环 + CI 兜底
Phase 3 (第 3-4 周)   架构护栏
Phase 4 (第 5-6 周)   工具基础设施（Agent 自主使用）
Phase 5 (第 7-8 周)   编排与多 Agent 并行
Phase 6 (第 9-10 周)  质量门控与垃圾回收
```

---

## 2. Phase 0：基础设施变更（第 1 周）

> 目标：完成 user-space 迁移、管理员识别和 TaskClassifier 扩展，为后续所有 Phase 扫清障碍。

### 2.1 user-space 迁移

**改动范围**：

1. 新增环境变量 `USER_SPACE_ROOT`，默认值 `/data/your-ai-users`
2. 修改所有引用 `user-space/` 的路径为 `process.env.USER_SPACE_ROOT`
3. 主要涉及的模块：
   - `src/kernel/memory/` — 配置加载（AIEOS 协议文件的读写路径）
   - `src/kernel/onboarding/` — 新用户引导（生成初始配置的目标路径）
   - `src/kernel/agents/` — Claude Code Bridge（subprocess cwd）
   - `config/` — 全局默认配置的复制逻辑
4. 迁移脚本 `scripts/migrate-user-space.sh`：将现有 `user-space/*` 移到新路径

**向后兼容**：`USER_SPACE_ROOT` 默认值可以暂时设为 `./user-space` 以兼容，但 `.env.example` 中应引导设置为项目外路径。

### 2.2 管理员识别 + TaskClassifier 扩展

**改动范围**：

1. 新增环境变量 `ADMIN_USER_IDS`（逗号分隔的用户 ID 列表）
2. 新增 `src/shared/utils/admin.ts`：
   ```typescript
   export function isAdmin(userId: string): boolean {
     const adminIds = (process.env.ADMIN_USER_IDS || "")
       .split(",")
       .map((s) => s.trim());
     return adminIds.includes(userId);
   }
   ```
3. 扩展 `src/kernel/classifier/task-classifier.ts`：
   - 在 `TaskType` 中新增 `'harness'`
   - 在分类 prompt 中添加 harness 类型的判定标准：
     ```
     harness: 涉及代码修改（修 bug/加功能/重构）、项目基础设施操作
     （跑测试/查架构/看覆盖率）、文档维护、部署运维。
     注意：编程知识问答（"什么是泛型"）不是 harness，是 chat。
     ```
   - 注意：TaskClassifier 不需要知道谁是管理员——它只负责判断意图类型
4. 修改 Claude Code Bridge 调用逻辑：

   ```typescript
   const taskType = await taskClassifier.classify(message);
   const isHarnessTask = taskType === "harness" && isAdmin(userId);

   const cwd = isHarnessTask
     ? process.env.PROJECT_ROOT || process.cwd()
     : getUserSpacePath(userId); // 管理员的非 harness 对话也走这里

   if (isHarnessTask) {
     // 注入管理员的 SOUL.md + IDENTITY.md，保持助手人格
     const soul = readFile(getUserSpacePath(userId) + "/memory/SOUL.md");
     const identity = readFile(
       getUserSpacePath(userId) + "/memory/IDENTITY.md",
     );
     spawn(
       "claude",
       [
         "--print",
         "-p",
         prompt,
         "--append-system-prompt",
         `${soul}\n${identity}`,
       ],
       { cwd },
     );
   } else {
     spawn("claude", ["--print", "-p", prompt], { cwd });
   }
   ```

5. 处理非管理员的 harness 请求：当 `taskType === 'harness' && !isAdmin(userId)` 时，静默降级为 chat 类型正常回答（不提示"无权限"，不暴露系统内部概念）

### 2.3 Phase 0 验收标准

- [ ] `USER_SPACE_ROOT` 环境变量生效，用户数据存放在项目目录外
- [ ] 管理员也拥有完整的 user-space（SOUL.md/IDENTITY.md/USER.md/AGENTS.md）
- [ ] 现有用户数据无损迁移
- [ ] TaskClassifier 支持 `harness` 类型，分类准确率可接受
- [ ] 管理员发工程消息（如"跑下测试"）→ subprocess cwd 为项目根
- [ ] 管理员发日常消息（如"明天天气"）→ subprocess cwd 为管理员自己的 user-space
- [ ] 普通用户发工程消息 → 降级为 chat，cwd 为 user-space
- [ ] 在项目根放测试 `CLAUDE.md`，验证：harness 模式能读到，非 harness 模式读不到

---

## 3. Phase 1：文档基础（第 1-2 周）

> 目标：建立 CLAUDE.md + .harness/ 文档骨架，管理员开箱即有工程上下文。

### 3.1 新建 CLAUDE.md（项目根目录）

~80 行的目录文件。管理员的 claude subprocess 在项目根执行时自动加载：

```markdown
# CLAUDE.md — Your-AI 工程指引

## 项目定位

个人 AI 助手平台，多通道接入（Feishu/Telegram/Web）+ 5 层记忆 + 自我进化。
你正在工程模式下运行——当前消息被识别为工程任务（harness 类型）。

## 核心工作纪律（不可违反）

1. 每次修改代码后，运行 `bun run check:all`
2. 如果任何检查不通过，立即修复，重新运行，直到全部通过
3. 只有 check:all 全部通过后，才能向管理员报告完成
4. 不要问管理员"要不要跑测试"——改完代码就跑，这是你的本职工作
5. 如果本次任务中发现了新的错误模式，修复后将其追加到 .harness/pitfalls.md
6. 代码和文档在同一个分支、同一次提交中完成——不允许"代码先合，文档后补"

## .harness/ 文档更新纪律

check:all 通过后，提交前，逐条自检：

- 新增/删除了模块或文件？→ 更新 .harness/doc-source-map.json
- 改变了模块间依赖关系或分层结构？→ 更新 .harness/architecture.md
- 引入了新的编码模式或约定？→ 更新 .harness/conventions.md
- 发现了新的错误模式或陷阱？→ 追加 .harness/pitfalls.md
- 做了重大设计决策？→ 在 .harness/design-docs/ 新增 ADR
- 引入了新的领域概念或术语？→ 更新 .harness/glossary.md
- 测试策略有变化？→ 更新 .harness/testing.md
  自检完成后运行 `bun run check:docs` 验证文档一致性。

## 关键命令

- 全量检查: `bun run check:all`（每次改完代码必跑）
- 测试: `bun test`
- Lint: `bun run lint` / `bun run lint:fix`
- 格式化: `bun run format`
- 架构检查: `bun run check:arch`

## Git 工作流

- 开始工程任务前: `git checkout -b agent/{简短描述}`
- commit 遵循 Conventional Commits（feat: / fix: / refactor: / docs:）
- 完成后告知管理员分支名，由管理员决定合并

## 架构概览

→ .harness/architecture.md

五层架构: Gateway → Kernel → Shared → UserSpace → Infra
依赖方向严格向下。

## 分层规则

- gateway/ → 可引用 kernel/(公开 API), shared/
- kernel/ → 可引用 shared/，禁止引用 gateway/
- shared/ → 零依赖（纯类型/工具函数）
- mcp-servers/ → 通过 stdio 隔离

## 编码约定

→ .harness/conventions.md

## 常见陷阱（必读）

→ .harness/pitfalls.md

## 双上下文说明

本项目有两套上下文：

- config/ 下的 AIEOS 协议 = AI 助手面向用户的交互行为（复制到每个用户的 user-space）
- CLAUDE.md + .harness/ = 工程开发行为（仅在 harness 模式加载）
  修改 config/ 下文件需额外审慎，直接影响所有用户体验。

## 设计文档

→ .harness/design-docs/

## 现有系统文档

→ docs/manifest.json

## 工作模式说明

你正在 headless (--print) 模式下运行。

- 如果用户意图不是工程任务（可能是分类器误判），按普通对话回答即可
- 复杂任务（涉及 3+ 文件）先输出 plan，等管理员确认后逐步执行
- 每步完成后自动跑 check:all，通过后执行文档自检 checklist，最后 check:docs
- 代码 + 文档一起提交，不要分开
```

### 3.2 .harness/ 目录结构

```
.harness/
├── architecture.md          # 架构地图 + 分层规则 + 模块依赖图 + 消息流路径
├── conventions.md           # 编码约定（命名、错误处理、类型、日志等）
├── pitfalls.md              # Agent 常见陷阱库（初始 5 条，Agent 记录 + 管理员审核）
├── testing.md               # 测试约定和基础设施
├── glossary.md              # 术语表（AIEOS、UserSpace 等概念）
├── doc-source-map.json      # 文档→源码映射（新鲜度检查用）
└── design-docs/
    ├── TEMPLATE.md
    ├── 001-layered-arch.md
    ├── 002-aieos-protocol.md
    ├── 003-harness-system.md
    └── 004-user-space-migration.md
```

### 3.3 architecture.md 核心内容

**分层架构图**：

```
┌─────────────────────────────────────────┐
│  Gateway (src/gateway/)                 │
│  HTTP/WS 服务 / 通道管理 / 中间件        │
├─────────────────────────────────────────┤
│  Kernel (src/kernel/)                   │
│  agents/ memory/ evolution/ classifier/ │
│  skills/ scheduling/ streaming/         │
│  编排: central-controller.ts             │
├─────────────────────────────────────────┤
│  Shared (src/shared/)                   │
│  types/ utils/ logging/ 纯函数+类型      │
├─────────────────────────────────────────┤
│  UserSpace (外部: $USER_SPACE_ROOT)     │  ← 已迁移到项目外
│  每用户: AIEOS 协议 + 记忆数据            │
├─────────────────────────────────────────┤
│  Infra (infra/ + mcp-servers/)          │
│  OpenViking / MCP Servers / PM2         │
└─────────────────────────────────────────┘
```

**消息流路径**：

```
User → Channel → Middleware(auth/rate-limit)
  → MessageRouter → OnboardingCheck → TaskClassifier

  TaskClassifier 结果:
  ├── chat/scheduled/automation/system
  │     → cwd = user-space(所有用户一致)
  │     → KnowledgeRouter → AgentRuntime → Response
  │
  └── harness
        ├── isAdmin? → cwd = 项目根(加载 CLAUDE.md)
        │               → AgentRuntime(工程模式) → Response
        └── !isAdmin → 降级 chat → 同上
```

### 3.4 pitfalls.md 初始内容

| 编号  | 陷阱                                   | 修复指令                                  |
| ----- | -------------------------------------- | ----------------------------------------- |
| P-001 | 在 shared/ 引入有状态逻辑              | 移至 kernel/ 对应子模块                   |
| P-002 | MCP Server 直接 import kernel 内部模块 | 必须通过 stdio 隔离                       |
| P-003 | 外部调用缺少 async 超时                | 所有 LLM/API 调用设超时                   |
| P-004 | 修改 config/ 未考虑用户侧影响          | 评估 AIEOS 文件复制链路                   |
| P-005 | 测试直接依赖外部服务                   | 用 test-utils/ 统一 mock                  |
| P-006 | user-space 路径硬编码                  | 必须通过 USER_SPACE_ROOT                  |
| P-007 | 代码改了但未更新 .harness/ 文档        | 提交前执行文档自检 checklist + check:docs |

**纪律**：Agent 发现新陷阱 → 追加到此文件 → 随代码一起提交 → 管理员 review 时审核。

### 3.5 Phase 1 验收标准

- [ ] CLAUDE.md 存在于项目根，≤ 80 行
- [ ] .harness/ 目录结构完整
- [ ] pitfalls.md ≥ 5 条
- [ ] 管理员发送工程消息（如"查看项目架构"），触发 harness 模式，获得基于 .harness/ 的回答
- [ ] 管理员发送日常消息（如"你好"），走普通 chat 模式，使用管理员自己的 user-space 上下文
- [ ] 普通用户的对话完全不受 CLAUDE.md 影响

---

## 4. Phase 2：本地质量闭环 + CI 兜底（第 2-3 周）

> 目标：Agent 改完代码后自动跑检查、自动修复，直到通过才交付。CI 作为人类合并 PR 时的最终防线。

### 4.1 核心设计：反馈循环在本地闭合

```
Agent 改代码
  → 自动运行 bun run check:all
  → 不通过？→ 自行修复 → 重新运行 → 循环直到通过
  → 全部通过 → 告知管理员"已完成，所有检查通过"
```

**Agent 不需要等管理员说"跑下测试"——改完代码就跑是它的本职工作。** 这通过 CLAUDE.md 中的"核心工作纪律"实现（见 Phase 1 的 CLAUDE.md 内容）。

### 4.2 GitHub Actions CI（人类兜底）

CI 不是给 Agent 用的反馈工具，而是给管理员合并分支时的二次确认。

`.github/workflows/ci.yml`：

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run format --check
      - run: bun test
      - run: bun run check:arch
      - run: bun run check:all
```

CI 结果通过 GitHub 通知或飞书/TG webhook 推送给管理员。Agent 不依赖 CI——它在本地已经跑过了。

### 4.3 测试骨架

优先覆盖三条主路径：消息路由 → 意图分类 → Agent 执行。

```
src/test-utils/
├── fixtures/         # 测试 fixtures
├── mocks/            # LLM mock、OpenViking mock、Channel SDK mock
└── helpers.ts        # 辅助函数
```

### 4.4 package.json 脚本

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "check:arch": "bun run scripts/check-architecture.ts",
    "check:conventions": "bun run scripts/lint-conventions.ts",
    "check:docs": "bun run scripts/check-docs.ts",
    "check:all": "bun run lint && bun run check:arch && bun run check:conventions && bun test"
  }
}
```

### 4.5 PR 模板

`.github/pull_request_template.md`：

```markdown
## What / Why

## Checklist

- [ ] `bun run check:all` 通过（Agent 应已自动完成）
- [ ] 新功能有测试
- [ ] 如修改 config/ 下 AIEOS 文件，已评估用户侧影响
- [ ] 如发现新陷阱，已更新 .harness/pitfalls.md
```

### 4.6 Phase 2 验收标准

- [ ] CI 首次绿灯
- [ ] `bun test` < 2 分钟
- [ ] 三条主路径有基础测试
- [ ] test-utils/ 提供 LLM 和 OpenViking mock
- [ ] Agent 在 harness 模式下改完代码后自动运行 check:all（通过 CLAUDE.md 纪律验证）

---

## 5. Phase 3：架构护栏（第 3-4 周）

> 目标：架构约束从"文档描述"变成"CI 机械执行"。

### 5.1 scripts/check-architecture.ts

扫描 `src/` 下 `.ts` 文件的 import 语句，验证分层规则。

**规则表**：

| 源层            | 允许引用                           | 禁止引用                  |
| --------------- | ---------------------------------- | ------------------------- |
| src/gateway/    | src/kernel/(公开 API), src/shared/ | —                         |
| src/kernel/     | src/shared/                        | src/gateway/              |
| src/shared/     | 无                                 | src/gateway/, src/kernel/ |
| mcp-servers/    | src/shared/                        | src/kernel/(内部)         |
| kernel 子模块间 | 对方 index.ts                      | 对方内部文件              |

**错误消息 = 修复指令**：

```
❌ 架构违规: src/shared/utils/format.ts:14
   引用了 src/kernel/memory/config.ts
   shared 层不允许依赖 kernel 层。
   修复: 将类型提取到 src/shared/types/，或通过依赖注入组装。
```

### 5.2 scripts/lint-conventions.ts

| 检查项          | 规则                              |
| --------------- | --------------------------------- |
| Logger 命名     | `new Logger('X')` 匹配所在类名    |
| 错误类          | 必须用 YourBotError + ERROR_CODES |
| Type import     | 纯类型用 `import type`            |
| 桶文件          | 每个子模块有 index.ts             |
| config/ 保护    | 修改 config/ 时输出警告           |
| user-space 路径 | 禁止硬编码 user-space/ 路径       |

### 5.3 分阶段上线

1. 第一周 warn-only，收集违规清单
2. 逐模块修复 → 切 error
3. 全部通过后 CI 强制

### 5.4 Phase 3 验收标准

- [ ] `bun run check:arch` 零违规
- [ ] `bun run check:conventions` 通过
- [ ] CI 自动运行架构检查
- [ ] 所有错误消息包含修复指令

---

## 6. Phase 4：工具基础设施（第 5-6 周）

> 目标：Agent 拥有完整的本地质量检查工具链，能自主运行并根据结果自我修复。

### 6.1 设计原则

**Agent 自主使用，非管理员触发。** 管理员说"帮我加个缓存层"，Agent 自己知道改完要跑测试、跑 lint、跑架构检查。这些工具是 Agent 的"感官"，不需要管理员逐个指挥。

Harness 工具属于 Development Context，不放在 kernel 里：

```
scripts/                          # CLI 入口（Agent 直接 bash 调用）
.harness/tools/                   # 辅助工具逻辑（如有）
mcp-servers/harness/              # MCP 接口（可选，未来扩展用）
```

### 6.2 Agent 的完整工作循环

Agent 在 harness 模式下 cwd 是项目根，天然可以执行所有脚本：

```
Agent 改完代码
  → bash: bun run check:all
  → 解析输出：lint 2 errors, arch 0 violations, test 1 failed
  → bash: bun run lint:fix（自动修复 lint）
  → 修复失败的测试
  → bash: bun run check:all（再跑一遍）
  → 全部通过
  → .harness/ 文档自检（逐条 checklist）
  → 更新涉及的 .harness/ 文件
  → bash: bun run check:docs（验证文档一致性）
  → git commit（代码 + 文档同一次提交）
  → 告知管理员完成
```

不需要 MCP Server 包装——headless 模式下 bash 直接调用就够了。Git 操作同理，`git checkout -b`、`git add`、`git commit` 都通过 bash 执行，不需要内置 git 工具。

### 6.3 工具输出标准

所有 Harness 脚本的输出遵循三要素：**什么错了 + 在哪里 + 怎么修**。

```typescript
interface FixSuggestion {
  file: string;
  line?: number;
  problem: string;
  suggestion: string;
  severity: "error" | "warning" | "info";
}
```

这让 Agent 能自主理解错误并修复，而非只看到"failed"就卡住。

### 6.4 文档一致性检查（check:docs）

`scripts/check-docs.ts` 是文档更新纪律的机械兜底——Agent 自检可能遗漏，但 check:docs 能发现。

**检查项**：

| 检查                   | 逻辑                                                          | 输出                                    |
| ---------------------- | ------------------------------------------------------------- | --------------------------------------- |
| 新鲜度                 | 读 doc-source-map.json，对比文档与源码的 git 修改时间         | 列出源码比文档新 > 7 天的条目           |
| 映射覆盖               | 扫描 src/ 下的模块目录，检查是否都在 doc-source-map.json 中   | 列出未映射的模块                        |
| 引用有效性             | 解析 CLAUDE.md 和 .harness/\*.md 中的所有 `→ path` 引用       | 列出指向不存在文件的引用                |
| architecture.md 一致性 | 对比 architecture.md 中列出的模块与 src/ 实际目录             | 列出 architecture.md 中缺失或多余的模块 |
| pitfalls 格式          | 检查 pitfalls.md 每条是否包含编号、陷阱描述、修复指令三个字段 | 列出格式不完整的条目                    |

**输出格式**（Agent 友好）：

```
📋 文档一致性检查结果

✅ 引用有效性: 全部通过 (12/12)
✅ pitfalls 格式: 全部通过 (8/8)

⚠️ 新鲜度:
  - docs/08-memory-system.md 过期 12 天
    源码变更: src/kernel/memory/cache-layer.ts (3 天前新增)
    建议: 更新文档中 memory 模块的架构描述

⚠️ 映射覆盖:
  - src/kernel/harness/ 未在 doc-source-map.json 中映射
    建议: 添加映射条目

❌ architecture.md 一致性:
  - architecture.md 未列出 src/kernel/workspace/ 模块
    建议: 在 Kernel 层描述中补充 workspace 子模块
```

**集成到工作流**：

- Agent 在文档自检后运行 `bun run check:docs`，作为提交前的最后一道检查
- Phase 6 的 GC 调度器也定期运行，发现过期文档推送给管理员
- 未来可集成到 `check:all` 中（目前 check:all 只检查代码质量，check:docs 单独运行）

### 6.5 pitfalls.md 维护机制

**Agent 主动记录 + 管理员审核**：

CLAUDE.md 中的纪律要求 Agent 在发现新错误模式时自行追加到 pitfalls.md。但因为 pitfalls.md 是 git 管理的，管理员在 review 分支时可以审核新增条目的质量。

```
Agent 犯错 → 管理员指出 → Agent 修复代码
  → Agent 同时追加 pitfalls.md → 随代码一起提交到分支
  → 管理员 review 分支时审核 pitfalls 条目
  → 合并后，下次 harness 任务自动加载新 pitfall
```

### 6.6 Harness MCP Server（可选，未来扩展）

如果未来需要让非管理员也能调用受限工具集，或需要更结构化的输入/输出，可以基于 `McpServerBase` 创建 `mcp-servers/harness/index.ts`。当前阶段不是必须。

### 6.7 Phase 4 验收标准

- [ ] Agent 在 harness 模式下能自主运行 check:all 并根据结果修复
- [ ] Agent 完成代码修改后自觉执行 .harness/ 文档自检 checklist
- [ ] `bun run check:docs` 能检测过期文档、未映射模块、无效引用、architecture 不一致
- [ ] check:docs 输出包含具体修复建议（Agent 友好格式）
- [ ] pitfalls.md 在实际使用中至少新增 3 条（Agent 记录，管理员已审核）
- [ ] 所有脚本输出包含 fixSuggestions
- [ ] Agent 能自主执行 git 操作（创建分支、提交、推送）
- [ ] 代码和文档变更在同一次 commit 中提交

---

## 7. Phase 5：编排与多 Agent 并行（第 7-8 周）

> 目标：复杂任务有标准化流程，支持 2-3 个并行任务。

### 7.1 对话内 Plan-then-Execute 流程

复杂任务通过多轮对话完成，不需要持久化 exec-plan 文件（前期）：

```
管理员: "给 memory 模块加缓存层"

AI: 这是一个涉及多文件的任务，我先列出计划：

    1. 在 src/kernel/memory/ 新增 cache-layer.ts（缓存接口+实现）
    2. 修改 memory-retriever.ts 集成缓存
    3. 新增 __tests__/cache-layer.test.ts
    4. 更新 docs/08-memory-system.md

    确认后我从第 1 步开始。

管理员: "没问题，开始"

AI: [执行第 1 步，创建文件]
    [自动运行 bun run check:all]
    第 1 步完成，check:all 通过。继续第 2 步？

管理员: "继续"

AI: [执行第 2 步...]
    [自动运行 bun run check:all]
    ...全部完成，已提交到分支 agent/memory-cache。
```

**CLAUDE.md 中的编排指令**（已包含在 Phase 1 的 CLAUDE.md 内容中）：

- 涉及 3+ 文件变更 → 先输出 plan
- 每步完成后自动跑 check:all
- 全部完成后告知管理员分支名

**exec-plans/ 目录保留**但简化为仅存放模板，供 Agent 参考格式。未来如果需要多 Agent 协作分配任务，再引入持久化的 JSON exec-plan。

### 7.2 多 Agent 并行

管理员可以同时通过不同通道（或同一通道的不同对话）触发多个任务：

```
管理员 (飞书): "修复 telegram 通道的 bug"    → Agent A 处理
管理员 (TG):   "优化 memory 检索性能"        → Agent B 处理
```

**并行隔离**（通过 CLAUDE.md 中的 Git 工作流实现）：

- 每个任务在独立 git 分支工作（`agent/{简短描述}`）
- 不同任务应涉及不同模块
- 完成后推送分支，管理员审查合并

**多 subprocess 冲突缓解**：多个 `claude --print` 同时在项目根运行可能文件冲突。缓解方式：

1. 使用 git worktree 为每个并行任务创建隔离工作目录
2. CLAUDE.md 指示：开始前检测工作目录状态，有未提交更改则先 stash

### 7.3 Phase 5 验收标准

- [ ] plan-then-execute 流程完整运行至少 3 次
- [ ] Agent 每步自动运行 check:all 并自我修复
- [ ] 成功完成至少 1 次 2 个并行任务
- [ ] 并行任务无文件冲突

---

## 8. Phase 6：质量门控与垃圾回收（第 9-10 周）

> 目标：闭合"Agent 犯错 → 改善环境 → Agent 变强"的飞轮。

### 8.1 质量门控

5 个默认门控，由 `bun run check:all` 统一运行：

| 门控         | 阈值         | 工具                  |
| ------------ | ------------ | --------------------- |
| Lint         | 0 错误       | `bun run lint`        |
| Architecture | 0 违规       | `bun run check:arch`  |
| Test         | 100% 通过    | `bun test`            |
| Coverage     | ≥ 60%        | `bun test --coverage` |
| Docs         | 0 过期(>7天) | `bun run check:docs`  |

### 8.2 垃圾回收

由 `yourbot-scheduler`（PM2 进程）定期触发，结果推送到管理员通道：

| 扫描项           | 频率   | 动作           |
| ---------------- | ------ | -------------- |
| 过期文档         | 每日   | 通知管理员     |
| 死代码           | 每周   | 生成清理建议   |
| 测试覆盖率缺口   | 每周   | 列出未覆盖路径 |
| pitfalls.md 回顾 | 每两周 | 检查过时条目   |

### 8.3 Harness Dashboard

在 `src/gateway/index.ts` 添加（管理员认证保护）：

```
GET /harness/status  → 质量分数、最近门控结果、GC 状态
GET /harness/report  → 完整报告 + 改进建议
```

### 8.4 Phase 6 验收标准

- [ ] `bun run check:all` 一键运行全部门控
- [ ] GC 调度器至少运行 2 个周期
- [ ] pitfalls.md 累积到 15+ 条
- [ ] `/harness/status` 返回有意义的数据

---

## 9. 三份原始计划的精华吸收与取舍

### 吸收

| 来源   | 精华                                               | 体现        |
| ------ | -------------------------------------------------- | ----------- |
| 计划 1 | CI/CD 优先、Worktree 并行、ADR、分阶段上线         | Phase 2/5/3 |
| 计划 2 | JSON 进度跟踪、文档优先、错误输出三要素            | Phase 5/1/4 |
| 计划 3 | doc-source-map.json、MCP Server、Quality Gates、GC | Phase 1/4/6 |

### 取舍

| 放弃                                    | 原因                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `src/kernel/harness/` 模块              | 混淆运行时/开发时边界                                 |
| HarnessOrchestrator / AgentPoolManager  | 过度工程化，对话内 plan-then-execute 足够             |
| CentralController 集成 harness 任务类型 | harness 通过 cwd 切换实现，不走消息处理流程           |
| 重构 config/AGENTS.md 为 Harness 入口   | AGENTS.md 是 AIEOS 协议文件，不应混入工程规范         |
| 内置 Git 工具 / MCP 包装                | Agent 通过 bash 直接执行 git 和 scripts，无需额外抽象 |
| 持久化 exec-plan 文件                   | 前期对话内编排足够，后期多 Agent 协作时再引入         |
| CI 作为 Agent 反馈源                    | Agent 反馈在本地 check:all 闭合，CI 仅作人类兜底      |

---

## 10. 完整文件清单

### 新建

```
CLAUDE.md                                    # Harness 入口（Phase 1）

.harness/
├── architecture.md                          # Phase 1
├── conventions.md                           # Phase 1
├── pitfalls.md                              # Phase 1（Agent 记录 + 管理员审核）
├── testing.md                               # Phase 1
├── glossary.md                              # Phase 1
├── doc-source-map.json                      # Phase 1
└── design-docs/
    ├── TEMPLATE.md                          # Phase 1
    ├── 001-layered-arch.md                  # Phase 1
    ├── 002-aieos-protocol.md                # Phase 1
    ├── 003-harness-system.md                # Phase 1
    └── 004-user-space-migration.md          # Phase 0

.github/
├── workflows/ci.yml                         # Phase 2（人类兜底）
└── pull_request_template.md                 # Phase 2

scripts/
├── migrate-user-space.sh                    # Phase 0
├── check-architecture.ts                    # Phase 3
├── lint-conventions.ts                      # Phase 3
├── check-docs.ts                            # Phase 4
├── quality-gates.ts                         # Phase 6
└── dep-graph.ts                             # Phase 3

src/shared/utils/admin.ts                    # Phase 0
src/integration/architecture.integration.test.ts  # Phase 3
src/test-utils/                              # Phase 2
```

**不需要内置的工具**：

- Git 操作 → Agent 通过 bash 直接执行 `git checkout -b` / `git commit` 等
- 测试/lint/架构检查 → Agent 通过 bash 执行 `bun run check:all`
- Harness MCP Server → 可选，当前阶段 bash 调用足够

### 修改

| 路径                                       | 改动                                               | Phase |
| ------------------------------------------ | -------------------------------------------------- | ----- |
| `.env.example`                             | 新增 USER_SPACE_ROOT, ADMIN_USER_IDS, PROJECT_ROOT | 0     |
| `src/kernel/agents/*` (Bridge)             | cwd 根据 taskType + isAdmin 切换                   | 0     |
| `src/kernel/classifier/task-classifier.ts` | 新增 harness 任务类型                              | 0     |
| `src/shared/tasking/task.types.ts`         | TaskType 增加 'harness'                            | 0     |
| `src/kernel/memory/*`                      | 路径引用改为 USER_SPACE_ROOT                       | 0     |
| `src/kernel/onboarding/*`                  | 同上                                               | 0     |
| `package.json`                             | 新增 check:arch, check:all 等脚本                  | 2-3   |
| `src/gateway/index.ts`                     | 添加 /harness/ 路由                                | 6     |

### 明确不修改

| 路径             | 原因                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| config/AGENTS.md | AIEOS 协议，通过 cwd 隔离自然不会加载到 harness 上下文；管理员日常对话中通过 user-space 正常使用 |
| config/SOUL.md   | 同上                                                                                             |

---

## 11. 效果度量

每两周 Harness 健康检查：

| 指标                                  | 当前值 | 中级目标 |
| ------------------------------------- | ------ | -------- |
| Agent 改完代码后 check:all 自动通过率 | N/A    | ≥ 80%    |
| CI 反馈时间                           | 无     | < 3 min  |
| 测试覆盖率                            | 未知   | ≥ 60%    |
| 架构违规数                            | 未知   | 0        |
| pitfalls 条目                         | 0      | ≥ 20     |
| Agent 并行度                          | 0      | 2-3      |
| 管理员可远程触发工程任务              | 否     | 是       |
| harness 任务分类准确率                | N/A    | ≥ 90%    |
| 管理员日常对话不受 harness 污染       | N/A    | 是       |

---

## 12. 核心原则

1. **管理员首先是用户** — 管理员拥有完整的 user-space 和个性化配置，harness 模式仍保留 SOUL.md/IDENTITY.md
2. **cwd 即上下文** — 目录位置决定加载什么，不需要复杂的 system-prompt 拼接
3. **意图驱动，而非角色驱动** — TaskClassifier 判断"消息是不是工程任务"，而非"这人是不是管理员"
4. **Agent 自治，管理员决策** — Agent 自主运行检查、自主修复、自主记录 pitfalls；管理员负责审批 plan 和 review 结果
5. **反馈循环在本地闭合** — Agent 改完代码立刻跑 check:all，不依赖 CI；CI 是人类合并时的兜底
6. **错误消息即修复指令** — 所有工具输出告诉 Agent 具体怎么修
7. **对 slop 说不** — Agent 生成的代码保持与人类相同的质量标准
8. **渐进式上线** — 新规则先 warn 再 error
9. **文档是代码** — pitfalls.md 每次更新都是编码"制度记忆"
