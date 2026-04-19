# AGENTS.md — Your-AI 工程指引（通用 Agent 版）

> 本文件面向所有参与本项目开发的 AI Agent（Claude Code、Gemini CLI、Codex、Cursor 等）。
> 项目专属的 Claude Code 配置见 `CLAUDE.md`。

## 项目定位

个人 AI 助手平台，多通道接入（Feishu / Telegram / Web）+ 5 层记忆 + 自我进化。
Runtime: **Bun** | HTTP: **Hono** | Lint: **Biome** | 部署: **PM2**

## 核心工作纪律（不可违反）

1. **每次修改代码后**，运行 `bun run check:all`（lint + 架构检查 + 测试）
2. 检查不通过 → 立即修复并重跑，直到全部通过
3. 只有 check:all 全部通过后，才能报告完成
4. 改完代码就跑检查，不要询问是否需要跑
5. 发现新错误模式 → 追加到 `.harness/pitfalls.md`
6. **代码和文档在同一个分支、同一次提交中完成**——不允许"代码先合，文档后补"

## 关键命令

| 命令 | 用途 | 何时运行 |
|------|------|----------|
| `bun run check:all` | 全量检查（lint + arch + test） | 每次改完代码 |
| `bun run check:docs` | 文档一致性检查 | 提交前 |
| `bun test` | 运行测试 | 改完代码 |
| `bun run lint` / `bun run lint:fix` | Lint 检查/自动修复 | 改完代码 |
| `bun run format` | 格式化 | 改完代码 |
| `bun run check:arch` | 架构分层检查 | 改完代码 |
| `bun run check:coverage` | 覆盖率检查（变更文件 100% 行/函数覆盖） | 提交前 |

## 架构概览

五层架构，依赖方向严格向下：

```
Gateway (src/gateway/)     — HTTP/WS 服务 · 通道管理 · 中间件 · 消息路由
    ↓
Kernel (src/kernel/)       — 核心业务逻辑 · 编排 · 记忆 · 进化
    ↓
Shared (src/shared/)       — 纯类型 · 工具函数 · 零业务依赖
    ↓
Lessons (src/lessons/)     — 错误检测 · 经验提取 · 经验更新
    ↓
Infra (infra/ + mcp-servers/ + skills/)
```

### 依赖规则

| 源层 | 允许引用 | 禁止引用 |
|------|---------|---------|
| `src/gateway/` | `src/kernel/`(公开 API), `src/shared/` | — |
| `src/kernel/` | `src/shared/` | `src/gateway/` |
| `src/shared/` | 无 | `src/gateway/`, `src/kernel/`, `src/lessons/` |
| `src/lessons/` | `src/shared/` | `src/gateway/`, `src/kernel/` |
| `mcp-servers/` | `mcp-servers/shared/` | `src/kernel/`(内部) |
| kernel 子模块间 | 对方 `index.ts` | 对方内部文件 |

## 编码约定

### TypeScript 配置
- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitReturns: true`
- 模块: ESNext (ESM)，解析: bundler
- 路径别名: `@gateway/*`, `@kernel/*`, `@shared/*`

### Biome 规则
- 缩进: 2 空格 | 行宽: 100 | 单引号 | 必须分号 | 尾逗号
- `noUnusedVariables: error` | `noUnusedImports: error` | `noExplicitAny: error` | `useConst: error`

### 命名规范

| 类别 | 风格 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `task-classifier.ts` |
| 测试文件 | 同名 `.test.ts` | `task-classifier.test.ts` |
| 类名 | PascalCase | `CentralController` |
| 方法/函数 | camelCase | `handleIncomingMessage` |
| 常量 | UPPER_SNAKE_CASE | `ERROR_CODES` |
| 类型/接口 | PascalCase | `TaskType` |

### 错误处理
- 所有业务错误使用 `YourBotError` + `ERROR_CODES` 枚举
- 定义在 `src/shared/errors/error-codes.ts`

### Import 规范
- 纯类型使用 `import type`
- 每个子模块提供 `index.ts` 桶文件，外部通过 index 引用
- 避免循环依赖

### Logger
- 每个模块创建自己的 `Logger` 实例: `new Logger('ModuleName')`
- 日志消息用中文，结构化数据作为第二参数

## 测试规范

- 测试框架: **Bun Test**
- 测试文件与被测文件同目录: `foo.ts` → `foo.test.ts`
- 覆盖率要求: 变更文件 **行覆盖 100%、函数覆盖 100%**
- 单元测试 < 50ms/用例，集成测试 < 500ms/用例
- 所有外部依赖（LLM/API/OpenViking）在单测中必须 mock
- 共享 mock 在 `src/test-utils/` 中
- AAA 模式: Arrange → Act → Assert
- 禁止: `as any`、空断言、`sleep` 等待、硬编码外部地址

## Git 工作流

### 分支命名
```
agent/{feat|fix|refactor|docs}/{short-description}
```

### 提交规范（Conventional Commits）
```
feat: 添加 memory 缓存层
fix: 修复 Telegram 通道超时问题
refactor: 重构 memory-retriever 查询逻辑
docs: 更新 architecture.md
test: 补充 cache-layer 单元测试
chore: 更新 doc-source-map.json
```

- 每个逻辑单元一次 commit
- 代码变更和对应的 `.harness/` 文档更新放在同一个 commit 中
- 同一分支内 commit message 语言一致

### 禁止事项
- 不要直接在 main 分支上修改
- 不要 force push
- 不要修改不属于当前任务的文件

## .harness/ 文档更新纪律

check:all 通过后，提交前，逐条自检：

- 新增/删除了模块或文件？→ 更新 `.harness/doc-source-map.json`
- 改变了模块间依赖关系或分层结构？→ 更新 `.harness/architecture.md`
- 引入了新的编码模式或约定？→ 更新 `.harness/conventions.md`
- 发现了新的错误模式或陷阱？→ 追加 `.harness/pitfalls.md`
- 做了重大设计决策？→ 在 `.harness/design-docs/` 新增 ADR
- 引入了新的领域概念或术语？→ 更新 `.harness/glossary.md`
- 测试策略有变化？→ 更新 `.harness/testing.md`

自检完成后运行 `bun run check:docs` 验证文档一致性。

## PR 规范

```bash
gh pr create \
  --base main \
  --head agent/{type}/{short-description} \
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

## 双上下文说明

本项目有两套上下文：

| 上下文 | 路径 | 用途 |
|--------|------|------|
| AIEOS 协议 | `config/` (SOUL/IDENTITY/USER/AGENTS.md) | AI 助手面向用户的交互行为，复制到每个用户的 user-space |
| 工程指引 | `CLAUDE.md` + `AGENTS.md` + `.harness/` | 工程开发行为，仅在开发模式加载 |

**修改 `config/` 下文件需额外审慎**，直接影响所有用户体验。

## 常见陷阱（必读）

→ `.harness/pitfalls.md`（当前 20 条，每次犯错须追加）

关键陷阱速览：
- `shared/` 必须零依赖（纯类型+工具函数），有状态逻辑移到 `kernel/`
- MCP Server 通过 stdio 隔离，只能引用 `mcp-servers/shared/`
- 所有 LLM/API 调用必须设超时
- 禁止使用 `any` 类型（Biome 强制 error）
- kernel 子模块间通过 `index.ts` 桶文件引用，禁止 import 对方内部文件
- user-space 路径不能硬编码，必须通过配置/环境变量获取

## 参考文档索引

| 文档 | 路径 | 内容 |
|------|------|------|
| 架构地图 | `.harness/architecture.md` | 分层架构、依赖规则、消息流路径 |
| 编码约定 | `.harness/conventions.md` | TypeScript/Biome/命名/Logger/错误处理 |
| 测试规范 | `.harness/testing.md` | 分层测试、覆盖率、mock 策略 |
| 常见陷阱 | `.harness/pitfalls.md` | Agent 犯错记录 |
| 术语表 | `.harness/glossary.md` | 项目专有术语定义 |
| 设计文档 | `.harness/design-docs/` | ADR 和设计决策 |
| 文档映射 | `.harness/doc-source-map.json` | 源文件↔文档对应关系 |
| 系统文档 | `docs/manifest.json` | 现有系统文档索引 |
