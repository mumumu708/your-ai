# DD-003: Harness Engineering 系统

- **状态**: Draft
- **创建日期**: 2026-03-06

## 背景

YourBot 中 Claude Code 承担双重角色：用户服务 + 工程开发。需要一套机制让管理员通过对话触发工程任务，同时不污染普通用户的上下文。

## 目标

1. 管理员可通过 Feishu/Telegram 等通道触发工程任务
2. 工程上下文（CLAUDE.md + .harness/）不泄漏到用户对话
3. Agent 拥有完整的代码修改 + 质量检查能力

## 方案

### cwd 隔离

通过设置 Claude CLI subprocess 的 cwd 来控制上下文加载：
- harness 任务 → cwd = 项目根 → 自动加载 CLAUDE.md
- 其他任务 → cwd = user-space → 不加载 CLAUDE.md

### TaskClassifier 扩展

新增 `harness` 任务类型，判定标准：
- 涉及代码修改（修 bug、加功能、重构）
- 涉及项目基础设施（跑测试、查架构）
- 涉及文档维护、部署运维

### 身份检查

`taskType === 'harness' && isAdmin(userId)` 双重验证。
非管理员的 harness 请求静默降级为 chat。

### 文档体系

```
CLAUDE.md              — 入口（~60 行）
.harness/
├── architecture.md    — 架构地图
├── conventions.md     — 编码约定
├── pitfalls.md        — 陷阱库（Agent 自维护）
├── testing.md         — 测试约定
├── glossary.md        — 术语表
├── doc-source-map.json— 文档→源码映射
└── design-docs/       — 设计文档
```

## 分阶段落地

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | user-space 迁移 + 管理员识别 + TaskClassifier 扩展 | Planned |
| 1 | 文档基础（CLAUDE.md + .harness/） | In Progress |
| 2 | 本地质量闭环 + CI 兜底 | Planned |
| 3 | 架构护栏（check:arch, lint-conventions） | Planned |
| 4 | 工具基础设施 | Planned |
| 5 | 编排与多 Agent 并行 | Planned |
| 6 | 质量门控与垃圾回收 | Planned |

## 验收标准

- [ ] Phase 1: 文档骨架完整，CLAUDE.md ≤ 80 行
- [ ] Phase 0: harness 模式正确切换 cwd
- [ ] Phase 2: CI 首次绿灯

## 参考

- 完整设计文档: `docs/harness-engineering/Harness Engineering Design v4.md`
