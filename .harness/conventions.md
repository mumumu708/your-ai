# 编码约定

## TypeScript 配置

- `strict: true`，`noUncheckedIndexedAccess: true`，`noImplicitReturns: true`
- 模块系统: ESNext (ESM)，模块解析: bundler
- 路径别名: `@gateway/*`, `@kernel/*`, `@shared/*`（tsconfig paths）
- 类型文件: `bun-types`

## Biome (Lint + Format)

- 缩进: 2 空格
- 行宽: 100
- 引号: 单引号
- 分号: 总是
- 尾逗号: 总是
- `noUnusedVariables: error`
- `noUnusedImports: error`
- `noExplicitAny: error`
- `useConst: error`
- `noNonNullAssertion: warn`

## 命名规范

| 类别 | 风格 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `task-classifier.ts` |
| 测试文件 | 同名 `.test.ts` | `task-classifier.test.ts` |
| 类名 | PascalCase | `CentralController` |
| 方法/函数 | camelCase | `handleIncomingMessage` |
| 常量 | UPPER_SNAKE_CASE | `ERROR_CODES`, `MAX_CONCURRENT_SESSIONS` |
| 类型/接口 | PascalCase | `TaskType`, `AgentBridgeParams` |
| 类型文件 | `xxx-types.ts` 或 `xxx.types.ts` | `classifier-types.ts`, `task.types.ts` |

## Logger 使用

每个模块创建自己的 Logger 实例，模块名必须与类名/文件上下文匹配：

```typescript
private readonly logger = new Logger('TaskClassifier');
```

日志消息使用中文，结构化数据作为第二参数：

```typescript
this.logger.info('消息接收', { traceId, messageId, channel, userId });
this.logger.error('消息处理失败', { error: error.message });
```

## 错误处理

- 所有业务错误使用 `YourBotError`，带 `ERROR_CODES` 枚举值
- 错误码定义在 `src/shared/errors/error-codes.ts`
- 错误包含 context 对象用于调试

```typescript
throw new YourBotError(ERROR_CODES.AGENT_BUSY, '并发会话数已达上限', {
  current: this.activeSessions,
  max: this.maxConcurrent,
});
```

## Import 规范

- 纯类型使用 `import type`
- 相对路径引用（配合 tsconfig paths）
- 每个子模块提供 `index.ts` 桶文件，外部通过 index 引用
- 避免循环依赖

## 单例模式

`CentralController` 使用静态 `getInstance(deps)` 模式：

```typescript
static getInstance(deps: CentralControllerDeps): CentralController
static resetInstance(): void  // 仅用于测试
```

## 模块组织

- 每个 kernel 子模块是一个目录，包含：
  - 核心实现文件
  - 类型定义文件（`*-types.ts`）
  - 测试文件（`*.test.ts`，与实现文件同目录）
  - `index.ts` 桶文件（导出公开 API）

## 异步模式

- 所有 I/O 操作使用 async/await
- 子进程使用 `Bun.spawn()` + stream 处理
- 非关键操作（如 OpenViking 同步）失败时 try/catch 静默忽略，不阻塞主流程

## 并发安全

- 同一会话的消息通过 `SessionSerializer` 串行化，key 为 `${userId}:${channel}:${conversationId}`
- 不同会话可并行处理，互不阻塞
- Harness 任务额外通过 `HarnessMutex` 全局互斥，防止并发操作 git 工作目录
- 序列化器和互斥锁均采用 waiter-queue + 超时模式，`try/finally` 保证锁释放
