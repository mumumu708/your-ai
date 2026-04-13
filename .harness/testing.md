# 测试工程规范 (Testing Engineering Specification)

> **版本**: 1.0.0  
> **状态**: 强制执行  
> **适用范围**: 全部业务代码与基础设施代码  
> **最后更新**: 2026-03

---

## 1. 核心原则

**测试是生产代码的一等公民。** 测试代码与业务代码享有同等的代码审查标准、重构义务和可维护性要求。

| 原则         | 含义                                           | 违反示例                         |
| ------------ | ---------------------------------------------- | -------------------------------- |
| **确定性**   | 同一测试在任意环境、任意时刻运行结果一致       | 依赖当前时间、随机数、网络状态   |
| **隔离性**   | 测试之间零耦合，可任意顺序、并发执行           | 共享可变状态、依赖执行顺序       |
| **自解释性** | 测试失败时，仅凭用例名称和错误信息即可定位问题 | 笼统命名如 `test1`、`testHelper` |
| **速度**     | 单元测试 < 50ms/用例，集成测试 < 500ms/用例    | 单测内发真实 HTTP 请求           |
| **最小覆盖** | 每个测试只验证一个行为，断言集中于单一关注点   | 一个用例里断言 10 个不相关字段   |

---

## 2. 测试框架与工具链

| 工具                  | 用途               | 版本要求 |
| --------------------- | ------------------ | -------- |
| Bun Test              | 测试运行器 + 断言  | ≥ 1.1    |
| `bun test --coverage` | 行/函数/分支覆盖率 | —        |
| `lcov`                | 覆盖率报告格式     | —        |
| `check:coverage`      | 变更文件覆盖率卡点 | 自研脚本 |
| nyc (Istanbul CLI)            | 覆盖率报告 + 阈值校验 | ≥ 18.0  |
| istanbul-lib-coverage         | 覆盖率数据处理        | ≥ 3.2   |
| Stryker-JS                    | 变异测试              | ≥ 9.6   |

---

## 3. 分层模型

测试分为三层，每层有明确的边界、速度要求和职责。**禁止跨层混用。**

### 3.1 单元测试（Unit）

| 属性       | 规定                                               |
| ---------- | -------------------------------------------------- |
| 文件名     | `*.test.ts`                                        |
| 位置       | 与被测文件同目录                                   |
| 目标       | 单个函数 / 类 / 模块的行为                         |
| 外部依赖   | **全部 mock**（LLM、HTTP、数据库、文件系统、时钟） |
| 执行时间   | **单用例 ≤ 50ms**，超出需标注 `@slow` 并给出理由   |
| 覆盖率要求 | 变更文件行覆盖 ≥ 100%，函数覆盖 ≥ 100%             |

### 3.2 集成测试（Integration）

| 属性       | 规定                              |
| ---------- | --------------------------------- |
| 文件名     | `*.integration.test.ts`           |
| 位置       | `src/integration/`                |
| 目标       | 模块间协作、管道端到端数据流      |
| 外部依赖   | 外部服务 mock，**模块间真实连接** |
| 执行时间   | **单用例 ≤ 500ms**                |
| 覆盖率要求 | 关键路径必须有对应集成用例        |

### 3.3 端到端测试（E2E）

| 属性       | 规定                                                  |
| ---------- | ----------------------------------------------------- |
| 文件名     | `*.e2e.test.ts`                                       |
| 位置       | `src/e2e/`                                            |
| 目标       | 用户视角的完整业务场景                                |
| 外部依赖   | 仅 mock 不可控的第三方（LLM API），通道 SDK 使用 stub |
| 执行时间   | **单用例 ≤ 2s**                                       |
| 覆盖率要求 | 每个核心业务流至少 1 条 happy path + 1 条 error path  |

### 3.4 测试金字塔比例

目标比例：**单元 70% · 集成 20% · E2E 10%**。PR 审查时若集成/E2E 比例畸高需给出合理说明。

---

## 4. 目录结构

```
src/
├── kernel/
│   ├── agents/
│   │   ├── agent-runtime.ts
│   │   ├── agent-runtime.test.ts          ← 单元测试：同目录
│   │   └── __fixtures__/                  ← 该模块专用测试数据
│   │       └── sample-agent-config.json
│   └── pipeline/
│       ├── message-handler.ts
│       └── message-handler.test.ts
├── integration/                            ← 集成测试
│   ├── message-pipeline.integration.test.ts
│   ├── streaming-pipeline.integration.test.ts
│   └── __fixtures__/                       ← 集成测试共享数据
├── e2e/                                    ← 端到端测试
│   ├── core-pipeline.e2e.test.ts
│   └── __fixtures__/
├── test-utils/                             ← 测试基础设施（不含业务逻辑）
│   ├── index.ts                            ← 统一导出
│   ├── mock-ov-deps.ts                     ← OpenViking 外部依赖 mock
│   ├── mock-light-llm.ts                   ← LightLLMClient mock
│   ├── factories.ts                        ← 测试数据工厂
│   ├── assertions.ts                       ← 自定义断言 / matcher
│   └── clock.ts                            ← 时间控制工具
└── __fixtures__/                           ← 全局共享测试数据
    └── common-config.json
```

### 4.1 `__fixtures__/` 规则

- 测试数据以 JSON/TS 文件存放于 `__fixtures__/`，**禁止在测试代码中硬编码大段 JSON**。
- 就近原则：仅单个模块使用的 fixture 放模块目录下；跨模块共享的提升到 `src/__fixtures__/`。
- Fixture 文件禁止包含真实用户数据或密钥。

---

## 5. 命名与结构规范

### 5.1 文件命名

| 类型       | 模式                            | 示例                                   |
| ---------- | ------------------------------- | -------------------------------------- |
| 单元测试   | `<module>.test.ts`              | `agent-runtime.test.ts`                |
| 集成测试   | `<feature>.integration.test.ts` | `message-pipeline.integration.test.ts` |
| 端到端     | `<scenario>.e2e.test.ts`        | `core-pipeline.e2e.test.ts`            |
| 测试工厂   | `factories.ts`                  | —                                      |
| 自定义断言 | `assertions.ts`                 | —                                      |

### 5.2 `describe` / `it` 命名

采用 **"Given-When-Then"** 或 **"主语-行为-预期"** 模式，用中文或英文皆可，但同一仓库必须统一。

```typescript
describe("AgentRuntime", () => {
  describe("execute", () => {
    it("should return structured response when LLM returns valid JSON", async () => {
      // ...
    });

    it("should throw AgentTimeoutError when LLM exceeds 30s", async () => {
      // ...
    });

    it("should fallback to default prompt when knowledgeRouter returns null", async () => {
      // ...
    });
  });
});
```

**命名禁忌：**

- ❌ `it("works")` — 没有表达任何行为
- ❌ `it("test execute")` — 重复方法名，未描述预期
- ❌ `it("should work correctly")` — "correctly" 无信息量
- ✅ `it("should emit 'chunk' event for each SSE frame")` — 行为 + 预期具体

### 5.3 单用例结构（AAA 模式）

每个 `it` 块严格遵循 **Arrange → Act → Assert** 三段式，用空行分隔：

```typescript
it("should route to FAQ agent when intent is 'faq'", async () => {
  // Arrange
  const controller = createTestController({ intent: "faq" });
  const message = buildMessage({ text: "什么是退款政策？" });

  // Act
  const result = await controller.handle(message);

  // Assert
  expect(result.agentId).toBe("faq-agent");
  expect(result.response).toContain("退款");
});
```

- **一个 Act**：如果需要多次调用才能完成断言，考虑拆分用例或提取 helper。
- **断言聚焦**：每个用例的 Assert 只验证一个行为维度。验证返回值和副作用应分开用例。

---

## 6. Mock 策略

### 6.1 分层 Mock 规则

| 测试层 | Mock 什么                             | 不 Mock 什么     |
| ------ | ------------------------------------- | ---------------- |
| 单元   | 所有外部依赖、相邻模块                | 被测模块自身     |
| 集成   | 外部服务（LLM、OpenViking、通道 SDK） | 模块间的真实交互 |
| E2E    | 仅不可控第三方 API                    | 内部所有模块     |

### 6.2 共享 Mock（`src/test-utils/`）

#### `mock-ov-deps.ts` — CentralController 外部依赖

```typescript
export function createMockOVDeps(overrides?: Partial<OVDeps>): OVDeps {
  return {
    knowledgeRouter: {
      route: vi.fn().mockResolvedValue({ systemPrompt: "default" }),
    },
    ovClient: { send: vi.fn().mockResolvedValue(undefined) },
    contextManager: { getContext: vi.fn().mockResolvedValue(null) },
    configLoader: { load: vi.fn().mockReturnValue(DEFAULT_AIEOS_CONFIG) },
    postResponseAnalyzer: { analyze: vi.fn().mockResolvedValue(null) },
    ...overrides,
  };
}
```

#### `mock-light-llm.ts` — LightLLMClient

```typescript
export function createMockLightLLM(
  response: string = '{"text":"mock response"}',
): MockLightLLM {
  return {
    complete: vi.fn().mockResolvedValue({ content: response }),
    stream: vi.fn().mockImplementation(async function* () {
      yield { delta: response, done: true };
    }),
  };
}
```

#### `factories.ts` — 测试数据工厂

```typescript
// 使用 Builder 模式，支持链式覆盖
export function buildMessage(
  overrides?: Partial<IncomingMessage>,
): IncomingMessage {
  return {
    id: crypto.randomUUID(),
    text: "你好",
    channel: "wechat",
    userId: "test-user-001",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function buildAgentConfig(
  overrides?: Partial<AgentConfig>,
): AgentConfig {
  return {
    agentId: "test-agent",
    model: "gpt-4o-mini",
    maxTokens: 1024,
    temperature: 0,
    ...overrides,
  };
}
```

### 6.3 Mock 纪律

| 规则                        | 说明                                                    |
| --------------------------- | ------------------------------------------------------- |
| **Mock 必须可验证**         | 每个 mock 至少被一个断言检查调用次数或参数              |
| **禁止过度 mock**           | 如果 mock 超过 5 个依赖，说明被测单元耦合过重，优先重构 |
| **Mock 返回值必须类型安全** | 使用 `as MockType` 或泛型工厂，禁止 `as any`            |
| **Spy 优于 Stub**           | 当只需观察调用而不改变行为时，使用 `spyOn`              |

### 6.4 单例重置

所有单例在 `afterEach` 中强制重置，防止测试间污染：

```typescript
afterEach(() => {
  CentralController.resetInstance();
  vi.restoreAllMocks(); // 恢复所有 spy/mock
  vi.useRealTimers(); // 如使用了假时钟，必须恢复
});
```

---

## 7. 异步与时间控制

### 7.1 异步测试

```typescript
// ✅ 正确：使用 async/await，让 Bun 捕获超时
it("should resolve within timeout", async () => {
  const result = await controller.handle(message);
  expect(result).toBeDefined();
});

// ❌ 错误：忘记 await，测试永远 pass
it("should resolve within timeout", () => {
  controller.handle(message).then((result) => {
    expect(result).toBeDefined();
  });
});
```

### 7.2 定时器与时钟

涉及 `setTimeout` / `setInterval` / `Date.now()` 的逻辑，**必须使用假时钟**：

```typescript
beforeEach(() => {
  vi.useFakeTimers();
});

it("should retry after 3s backoff", async () => {
  const promise = controller.handleWithRetry(message);
  vi.advanceTimersByTime(3000);
  const result = await promise;
  expect(result.retryCount).toBe(1);
});

afterEach(() => {
  vi.useRealTimers();
});
```

### 7.3 流式响应测试

```typescript
it("should yield all chunks in order", async () => {
  const chunks: string[] = [];
  for await (const chunk of agent.stream(message)) {
    chunks.push(chunk.delta);
  }
  expect(chunks).toEqual(["Hello", " ", "World"]);
});
```

---

## 8. 边界条件与防御性测试

每个公开函数/方法必须覆盖以下类别，按优先级排列：

### 8.1 必须覆盖

| 类别       | 示例                                                  |
| ---------- | ----------------------------------------------------- |
| Happy path | 正常输入 → 预期输出                                   |
| 空值/缺省  | `null`、`undefined`、空字符串、空数组                 |
| 错误路径   | 依赖抛异常时的行为（是 rethrow、fallback 还是降级？） |
| 超时       | 网络调用/LLM 调用超过阈值                             |
| 并发       | 同一资源的并发访问（单例、缓存）                      |

### 8.2 推荐覆盖

| 类别      | 示例                                                   |
| --------- | ------------------------------------------------------ |
| 边界值    | 最大 token 数、最长消息长度                            |
| 幂等性    | 同一消息重复处理结果一致                               |
| 状态转换  | Agent 从 idle → running → completed → error 的每个转换 |
| 回退/降级 | 主路径失败后的 fallback 行为                           |

---

## 9. 覆盖率要求

### 9.1 卡点规则

| 维度       | 变更文件要求 | 全量基线 |
| ---------- | ------------ | -------- |
| 行覆盖率   | **= 100%**   | ≥ 100%   |
| 函数覆盖率 | **= 100%**   | ≥ 100%   |
| 分支覆盖率 | **≥ 90%**    | ≥ 90%    |

### 9.2 执行机制

```bash
# 完整覆盖率检查流程 (Istanbul/nyc)
bun test --coverage            # 生成 coverage/lcov.info
bun run scripts/lcov-to-nyc.ts # 转换为 Istanbul JSON (.nyc_output/out.json)
bunx nyc report                # 生成报告 (text + lcov + html)
bunx nyc check-coverage        # 全局阈值校验
bun run scripts/check-coverage.ts # 变更文件 per-file 100% 卡点

# 快捷命令
bun run check:coverage          # 测试 + 转换 + 阈值校验 (一条命令)
bun run test:coverage:html      # 生成 HTML 可视化报告
```

### 9.5 变异测试 (Mutation Testing)

变异测试是覆盖率的补充验证手段，用于检测"假断言"（测试通过但未真正验证逻辑）。

| 属性 | 规定 |
|------|------|
| 工具 | Stryker-JS (`stryker.config.mjs`) |
| 运行器 | command runner (`bun test`) |
| 变异范围 | `src/**/*.ts`（排除测试文件和类型文件） |
| 阈值 | break: 50%, low: 60%, high: 80% |
| 执行时机 | 开发完成 + 覆盖率通过后，提交前 |

**开发闭环：**

```
编码 → 单元/集成测试 → check:coverage (Istanbul) → test:mutate (Stryker) → 通过 → 提交
```

存活变异体的处理：
1. 查看变异类型和位置
2. 增强对应测试的断言精度
3. 重新运行变异测试确认已杀死

### 9.3 覆盖率豁免

极少数场景允许豁免，但必须满足：

- 在文件顶部添加 `/* coverage:ignore-file — <理由> */` 注释。
- 理由必须是以下之一：纯类型定义、自动生成代码、平台特异性代码（仅在特定运行时生效）。
- 豁免在 PR 审查中由至少一名 Tech Lead 批准。

---

## 10. 测试质量红线

以下任一项出现，PR **不得合入**：

| 红线                 | 说明                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| **Flaky Test**       | 同一代码多次运行结果不一致。发现后立即标记 `@flaky` 并创建 P1 修复工单 |
| **测试依赖执行顺序** | 单独运行失败、全量运行 pass（或反过来）                                |
| **Sleep/Delay 等待** | 禁止 `await sleep(1000)` 式轮询，使用事件驱动或假时钟                  |
| **断言缺失**         | `it` 块中无任何 `expect`（空测试）                                     |
| **忽略错误**         | `try { ... } catch {}` 吞掉异常而不断言                                |
| **快照滥用**         | 对接口响应、大段 JSON 使用 snapshot 而不做结构化断言                   |
| **`as any` 逃逸**    | Mock 中使用 `as any` 绕过类型检查                                      |
| **硬编码外部地址**   | 测试中出现真实 URL / IP / Token                                        |

---

## 11. 快照测试使用守则

快照测试（`toMatchSnapshot`）**仅允许**用于以下场景：

- UI 组件的 HTML 渲染输出
- 错误消息格式化结果
- 配置文件序列化

**禁止用于：**

- API 响应断言（使用结构化 `expect` 逐字段断言）
- 大段 JSON 的偷懒验证
- 频繁变动的输出

快照文件必须与测试文件同目录，纳入 Code Review 审查范围。

---

## 12. 测试数据管理

### 12.1 数据来源优先级

1. **工厂函数**（`buildMessage()`）— 首选，可组合、类型安全
2. **Fixture 文件**（`__fixtures__/*.json`）— 大体积静态数据
3. **行内构造** — 仅当数据极简且只在当前用例使用时

### 12.2 禁止事项

- ❌ 使用生产数据库快照作为测试数据
- ❌ 在 fixture 中包含真实用户信息 / API Key
- ❌ 跨测试文件 import 另一个测试文件中定义的数据（提取到 `test-utils/` 或 `__fixtures__/`）

---

## 13. CI/CD 集成

### 13.1 流水线阶段

```
┌─────────┐    ┌────────────┐    ┌─────────────┐    ┌───────────┐
│  Lint   │───▶│ Unit Tests │───▶│ Integration │───▶│   E2E     │
│         │    │ + Coverage │    │   Tests     │    │  Tests    │
└─────────┘    └────────────┘    └─────────────┘    └───────────┘
                     │
                     ▼
              ┌──────────────┐
              │check:coverage│
              │  (卡点检查)   │
              └──────────────┘
```

### 13.2 失败策略

| 阶段       | 失败行为                     |
| ---------- | ---------------------------- |
| 单元测试   | 立即终止，不进入后续阶段     |
| 覆盖率卡点 | 阻断合入，输出未达标文件清单 |
| 集成测试   | 阻断合入                     |
| E2E 测试   | 阻断合入，自动通知 on-call   |

### 13.3 超时设置

| 阶段          | 超时 |
| ------------- | ---- |
| 单个单元测试  | 5s   |
| 单个集成测试  | 15s  |
| 单个 E2E 测试 | 30s  |
| 全量测试套件  | 5min |

---

## 14. Flaky Test 管理

### 14.1 定义

连续运行 10 次，任意一次结果不一致即判定为 Flaky。

### 14.2 处理流程

1. 发现后立即标记 `it.skip` 并添加 `// FLAKY: <issue-link>` 注释。
2. 创建 P1 工单，SLA 为 **2 个工作日内修复**。
3. 修复后必须本地连续运行 20 次全部通过才可移除 skip。
4. 月度统计 Flaky 次数，纳入工程质量看板。

---

## 15. 测试审查清单（Code Review）

审查者在评审测试代码时，逐项检查：

- [ ] 用例名称是否清晰表达了被测行为和预期结果
- [ ] 是否遵循 AAA 模式，三段式清晰分隔
- [ ] 是否存在无断言的空测试
- [ ] Mock 是否有对应的调用断言（`toHaveBeenCalledWith`）
- [ ] 是否使用了 `as any` 或跳过类型检查
- [ ] 异步测试是否正确 `await`
- [ ] 是否存在 `sleep` / 硬编码延迟
- [ ] 单例和全局状态是否在 `afterEach` 中重置
- [ ] 覆盖率是否满足卡点要求
- [ ] 边界条件（null、空、超时、错误）是否覆盖

---

## 16. 运行命令速查

```bash
# 基础运行
bun test                              # 全量测试
bun test --coverage                   # 带覆盖率
bun test src/kernel/                  # 指定目录
bun test agent-runtime                # 模糊匹配文件名

# 分层运行
bun test --grep "*.test.ts"           # 仅单元测试
bun test src/integration/             # 仅集成测试
bun test src/e2e/                     # 仅 E2E 测试

# 覆盖率卡点
bun run check:coverage                # 变更文件 100% 卡点

# 调试
bun test --only agent-runtime         # 运行单个文件
bun test --bail                       # 首个失败即停止
BUN_DEBUG=1 bun test                  # 详细日志
```

---

## 附录 A：反模式速查表

| 反模式                        | 问题                     | 正确做法                             |
| ----------------------------- | ------------------------ | ------------------------------------ |
| 测试中 `console.log` 调试     | 噪音，合入后遗留         | 使用断言验证，调试完删除             |
| `expect(result).toBeTruthy()` | 无法区分具体值           | `expect(result).toBe(expectedValue)` |
| 一个 `it` 中 10+ 断言         | 失败时定位困难           | 拆分为多个用例                       |
| 拷贝粘贴测试用例              | 维护成本倍增             | 提取 helper 或使用 `it.each`         |
| `it.skip` 长期存在            | 覆盖率虚高               | 限时修复或删除                       |
| Mock 返回 `{}`                | 类型不安全，隐藏真实问题 | 使用工厂函数返回完整类型             |
| 测试私有方法                  | 实现耦合，重构即碎       | 通过公开接口间接测试                 |

## 附录 B：常用断言模式

```typescript
// 异常断言
await expect(controller.handle(badMsg)).rejects.toThrow(AgentTimeoutError);

// 精确调用断言
expect(mockLLM.complete).toHaveBeenCalledTimes(1);
expect(mockLLM.complete).toHaveBeenCalledWith(
  expect.objectContaining({ model: "gpt-4o-mini" }),
);

// 部分匹配
expect(result).toEqual(
  expect.objectContaining({
    agentId: "faq-agent",
    status: "completed",
  }),
);

// 数组包含
expect(result.tags).toContain("urgent");
expect(result.items).toHaveLength(3);

// 异步事件
const eventPromise = once(emitter, "done");
controller.start();
await expect(eventPromise).resolves.toBeDefined();
```
