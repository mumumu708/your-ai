# DD-001: 分层架构

- **状态**: Implemented
- **创建日期**: 2026-03-06

## 背景

YourBot 需要清晰的模块边界来支撑多人协作和 Agent 自主开发。

## 目标

建立严格的分层依赖规则，防止循环依赖和层级穿透。

## 方案

### 五层架构

```
Gateway → Kernel → Shared → UserSpace → Infra
```

依赖方向严格向下，不允许反向引用。

### 各层职责

| 层 | 目录 | 职责 | 可引用 |
|----|------|------|--------|
| Gateway | src/gateway/ | HTTP/WS 服务、通道管理、中间件 | kernel/(公开API), shared/ |
| Kernel | src/kernel/ | 核心业务：编排、记忆、进化、Agent | shared/ |
| Shared | src/shared/ | 纯类型、工具函数、零依赖 | 无 |
| UserSpace | user-space/ | 用户数据（AIEOS 协议 + 记忆） | N/A（数据层） |
| Infra | infra/, mcp-servers/ | 基础设施、MCP Server | mcp-servers/shared/ |

### Kernel 子模块隔离

子模块间通过 `index.ts` 桶文件交互，禁止直接引用对方内部文件。

## 验收标准

- [x] 所有模块遵循依赖方向
- [x] 每个 kernel 子模块有 index.ts
- [ ] `bun run check:arch` 零违规（Phase 3 实现）
