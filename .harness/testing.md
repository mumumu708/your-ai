# 测试约定

## 测试框架

- **运行器**: Bun 内置测试运行器（`bun test`）
- **断言**: Bun 内置 expect API
- **覆盖率**: `bun test --coverage`

## 目录结构

```
src/
├── kernel/agents/
│   ├── agent-runtime.ts
│   └── agent-runtime.test.ts       ← 单元测试与实现同目录
├── integration/                     ← 集成测试
│   ├── message-pipeline.integration.test.ts
│   ├── streaming-pipeline.integration.test.ts
│   └── ...
├── e2e/                             ← 端到端测试
│   └── core-pipeline.e2e.test.ts
└── test-utils/                      ← 测试工具
    ├── index.ts                     ← 统一导出
    ├── mock-ov-deps.ts              ← 共享 mock（OpenViking 等外部依赖）
    └── mock-light-llm.ts            ← 共享 mock（LightLLMClient）
```

## 命名规范

| 类型 | 文件名模式 | 位置 |
|------|-----------|------|
| 单元测试 | `*.test.ts` | 与实现文件同目录 |
| 集成测试 | `*.integration.test.ts` | `src/integration/` |
| 端到端测试 | `*.e2e.test.ts` | `src/e2e/` |

## Mock 模式

### 外部依赖 Mock

使用 `src/test-utils/` 提供共享 mock：

**`mock-ov-deps.ts`** — CentralController 的外部依赖：
- `knowledgeRouter` — 返回固定 systemPrompt
- `ovClient` — 静默成功
- `contextManager` — 返回 null
- `configLoader` — 返回固定 AIEOS 配置
- `postResponseAnalyzer` — 返回 null

**`mock-light-llm.ts`** — LightLLMClient mock：
- `createMockLightLLM(response?)` — 返回带 complete/stream 的 mock 客户端

### 单例重置

CentralController 单例在测试间需要重置：
```typescript
afterEach(() => {
  CentralController.resetInstance();
});
```

## 测试原则

1. **不依赖外部服务** — LLM API、OpenViking、通道 SDK 全部 mock
2. **测试覆盖主路径** — 消息路由 → 意图分类 → Agent 执行
3. **测试与实现同目录** — 方便定位和维护
4. **集成测试验证管道** — 从消息入口到响应输出的完整流程

## 运行命令

```bash
bun test                    # 运行所有测试
bun test --coverage         # 带覆盖率
bun test src/kernel/        # 运行指定目录
bun test agent-runtime      # 按文件名模糊匹配
```
