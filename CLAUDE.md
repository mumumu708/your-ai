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
