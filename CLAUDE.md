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
- 文档检查: `bun run check:docs`（提交前必跑）
- 测试: `bun test`
- Lint: `bun run lint` / `bun run lint:fix`
- 格式化: `bun run format`
- 架构检查: `bun run check:arch`
- 覆盖率检查: `bun run check:coverage`（变更文件必须 100% 行/函数覆盖）
- 创建 PR: `gh pr create --base main --head {branch} --title "..." --body "..."`

## Git 工作流

### 开始前

1. `git status` 检查工作区是否干净
2. 如有未提交更改: `git stash` 暂存（可能是其他任务的残留）
3. `git checkout main && git pull origin main` 确保基于最新代码
4. `git checkout -b agent/{类型}/{简短描述}`

### 分支命名

- `agent/feat/memory-cache-layer` — 新功能
- `agent/fix/telegram-timeout` — Bug 修复
- `agent/refactor/memory-retriever` — 重构
- `agent/docs/update-architecture` — 纯文档更新

### 提交规范（Conventional Commits）

```
feat: 添加 memory 缓存层
fix: 修复 Telegram 通道超时问题
refactor: 重构 memory-retriever 查询逻辑
docs: 更新 architecture.md 中 memory 模块描述
test: 补充 cache-layer 单元测试
chore: 更新 doc-source-map.json
```

- 每个逻辑单元一次 commit（不要把所有改动堆在一个 commit 里）
- 代码变更和对应的 .harness/ 文档更新放在同一个 commit 中
- commit message 用中文或英文均可，但同一分支内保持一致

### 多步任务的提交策略

```
agent/feat/memory-cache-layer
├── commit 1: feat: 添加 cache-layer.ts 接口和实现
├── commit 2: feat: 集成缓存到 memory-retriever
├── commit 3: test: 补充 cache-layer 单元测试
└── commit 4: docs: 更新 architecture.md 和 doc-source-map
```

### 完成后

1. 确认 `bun run check:all` 通过
2. 确认 `bun run check:docs` 通过
3. `git push origin agent/{类型}/{简短描述}`
4. 通过 GitHub CLI 创建 PR：

   ```bash
   gh pr create \
     --base main \
     --head agent/{类型}/{简短描述} \
     --title "{type}: {简短描述}" \
     --body "## What / Why
   {变更说明}

   ## 变更范围
   - {涉及的模块和文件}

   ## Checklist
   - [x] bun run check:all 通过
   - [x] bun run check:docs 通过
   - [x] 新功能有测试
   - [ ] 如修改 config/ 下 AIEOS 文件，已评估用户侧影响
   - [ ] 如发现新陷阱，已更新 .harness/pitfalls.md"
   ```

5. 告知管理员: PR 链接、变更摘要、涉及的模块
6. 由管理员 review 后合并（merge / squash merge / rebase）

### PR 规范

- title 格式与 commit message 一致（`feat: xxx` / `fix: xxx`）
- body 必须包含 What/Why 和 Checklist
- 如果 PR 包含多个 commit，在 body 中列出每个 commit 的简要说明
- 如果 PR 涉及 .harness/ 文档更新，在 body 中标注具体更新了哪些文档

### 禁止事项

- 不要直接在 main 分支上修改
- 不要 force push
- 不要修改不属于当前任务的文件（除非是发现的 bug，记入 pitfalls 后另开分支修复）

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

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
