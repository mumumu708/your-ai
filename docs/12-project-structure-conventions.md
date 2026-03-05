# 第12章 项目结构与开发规范
> **本章目标**：定义与 TELGENT 对齐的完整项目目录结构、代码规范、测试规范和开发流程。
## 12.1 完整项目目录
```plaintext
YourBot/
├── src/
│   ├── gateway/                        # [Layer 1] 接入层
│   │   ├── channels/
│   │   │   ├── feishu.gateway.ts
│   │   │   ├── telegram.gateway.ts
│   │   │   ├── web.gateway.ts
│   │   │   └── api.gateway.ts
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts
│   │   │   ├── rate-limit.middleware.ts
│   │   │   └── transform.middleware.ts
│   │   ├── message-router.ts
│   │   └── index.ts
│   │
│   ├── kernel/                         # [Layer 2] 内核层
│   │   ├── central-controller.ts           # ★ 中央控制器
│   │   ├── agents/
│   │   │   ├── agent-runtime.ts
│   │   │   ├── agent-pool.ts
│   │   │   ├── agent-lifecycle.ts
│   │   │   ├── tool-executor.ts
│   │   │   └── stream-handler.ts
│   │   ├── sessioning/
│   │   │   ├── session-manager.ts
│   │   │   ├── session-store.ts
│   │   │   └── context-window.ts
│   │   ├── scheduling/
│   │   │   ├── scheduler.ts
│   │   │   ├── cron-parser.ts
│   │   │   └── job-registry.ts
│   │   ├── tasking/
│   │   │   ├── task-queue.ts
│   │   │   ├── task-router.ts
│   │   │   ├── concurrency.ts
│   │   │   └── retry-policy.ts
│   │   ├── memory/
│   │   │   ├── memory-manager.ts
│   │   │   ├── memory-retriever.ts
│   │   │   └── memory-compressor.ts
│   │   └── evolution/
│   │       ├── evolution-engine.ts
│   │       ├── skill-generator.ts
│   │       └── version-manager.ts
│   │
│   ├── shared/                         # [Layer 3] 共享层
│   │   ├── agents/
│   │   │   ├── agent-config.types.ts
│   │   │   └── agent-instance.types.ts
│   │   ├── messaging/
│   │   │   ├── bot-message.types.ts
│   │   │   ├── stream-event.types.ts
│   │   │   └── channel-adapter.types.ts
│   │   ├── tasking/
│   │   │   ├── task.types.ts
│   │   │   └── task-result.types.ts
│   │   ├── logging/
│   │   │   ├── logger.ts
│   │   │   └── log-levels.ts
│   │   └── utils/
│   │       ├── crypto.ts
│   │       ├── time.ts
│   │       └── validators.ts
│   │
│   └── community/                      # 社区扩展层
│       ├── plugins/
│       ├── integrations/
│       └── marketplace/
│
├── user-space/                         # [Layer 4] 用户空间
│   ├── {userId}/
│   │   ├── .claude/
│   │   ├── memory/
│   │   ├── workspace/
│   │   └── skills/
│   └── template/
│
├── infra/                              # [Layer 5] 基础设施
│   ├── docker/
│   ├── pm2/
│   ├── database/
│   └── scripts/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── tsconfig.json
├── bunfig.toml
├── package.json
└── ecosystem.config.js


```

## 12.2 四层架构职责边界


| 层级 | 允许 | 禁止 |
| --- | --- | --- |
| **Gateway** | 协议转换、签名验证、限流 | 业务逻辑、直接访问数据 |
| **Kernel** | 业务编排、Agent 管理、调度 | 直接处理 HTTP、访问外部服务 |
| **Shared** | 类型定义、工具函数、日志 | 包含业务逻辑、状态管理 |
| **UserSpace** | 文件存储、记忆文件 | 直接被外部访问 |


## 12.3 代码规范
- **语言**：100% TypeScript，严格模式 (`strict: true`)
- **开发工具**：Biome （替代 ESLint + Prettier）
- **路径别名**：`@gateway/*`、`@kernel/*`、`@shared/*`
- **错误处理**：自定义 YourBotError 类型，统一错误代码
## 12.4 命名规范


| 类型 | 规范 | 示例 |
| --- | --- | --- |
| 文件 | kebab-case | `agent-runtime.ts` |
| 类 | PascalCase | `AgentRuntime` |
| 接口 | PascalCase + I前缀 | `IChannel` |
| 常量 | UPPER_SNAKE | `MAX_RETRIES` |
| 函数 | camelCase | `resolveSession()` |
| 类型 | PascalCase | `TaskType` |


## 12.5 测试规范
```typescript
// 使用 bun test 运行
import { describe, test, expect, mock } from 'bun:test';

describe('CentralController', () => {
  test('should classify chat intent correctly', () => {
    const controller = CentralController.getInstance();
    const message = createMockMessage({ content: '你好' });
    expect(controller.classifyIntent(message)).toBe('chat');
  });

  test('should classify scheduled intent correctly', () => {
    const message = createMockMessage({ content: '每天上午9点提醒我' });
    expect(controller.classifyIntent(message)).toBe('scheduled');
  });
});
```

覆盖率要求：


| 类型 | 目标 | 范围 |
| --- | --- | --- |
| 单元测试 | > 80% | 所有 Shared 层 + Kernel 层核心 |
| 集成测试 | > 60% | Gateway → Kernel 路径 |
| E2E 测试 | 关键路径 | 完整对话流程 |


## 12.6 Git 工作流
```plaintext
main ────────────────────────────────
      \                                   /
       feat/xxx ───── PR Review ───── Merge
```

分支命名：`feat/xxx`、`fix/xxx`、`chore/xxx`Commit 规范：`feat(kernel): add session timeout handling`
## 12.7 测试策略与规范
YourBot AI 助手平台作为一个面向终端用户的智能助手系统，其代码质量和运行稳定性至关重要。在现代软件工程实践中，自动化测试是保障代码质量的基石，而高覆盖率的单元测试则是整个质量保障体系的第一道防线。本节从整体策略出发，定义项目的测试框架选型、覆盖率要求、各类外部依赖的 Mock 规范、测试文件组织方式以及与持续集成流水线的集成方案，确保每一行代码都经过充分验证，每一个功能分支都有对应的测试用例覆盖。
### 12.7.1 覆盖率要求：100% 单元测试覆盖率
**本项目实行 100% 单元测试覆盖率的强制性要求，不接受任何例外。**这一要求的核心理念是：如果一段代码值得被写入生产环境，那么它就值得被测试覆盖。未经测试的代码是潜在的故障点，尤其是在 AI 助手这类需要长时间稳定运行的系统中，任何未被覆盖的代码路径都可能在用户的关键操作中引发不可预期的错误。具体而言，以下四个覆盖率维度均必须达到百分之百：
- **行覆盖率（Line Coverage）**：100%。每一行可执行代码都必须被至少一个测试用例触达。这是最基本的覆盖率指标，确保不存在"死代码"或从未被执行的逻辑。
- **分支覆盖率（Branch Coverage）**：100%。所有条件分支（`if/else`、`switch/case`、三元表达式、`??`、`||` 等短路逻辑）均须覆盖正反两个方向。分支覆盖率是发现边界条件缺陷的关键指标。
- **函数覆盖率（Function Coverage）**：100%。所有导出函数和内部辅助函数均须被测试调用。如果一个函数从未在测试中被调用，说明它要么是多余的代码，要么是测试存在遗漏。
- **语句覆盖率（Statement Coverage）**：100%。不允许存在未被执行的语句。与行覆盖率互补，确保单行多语句的情况也被完整覆盖。对于确实无法在单元测试中直接执行的系统级代码（如进程入口的 `process.exit` 调用、平台特定的信号处理器等），开发者需要通过合理的架构设计将此类代码隔离到极小的胶水层中。这些胶水代码可以使用 `/* istanbul ignore next */` 或 `/* v8 ignore next */` 进行显式标记，但必须在代码审查过程中给出充分的豁免理由，并得到至少一名技术负责人的书面批准。此类豁免代码的总量严格控制在项目可执行代码总量的 0.5% 以内。为什么要坚持百分之百而非九十五或九十八的覆盖率目标？因为低于百分之百的目标意味着允许"一些"代码不被测试，而这个口子一旦打开，就会逐渐扩大。开发者会倾向于将难以测试的代码归入"可以不测"的范畴，最终导致覆盖率指标的名存实亡。只有将标准设定在百分之百，才能迫使团队从架构层面解决可测试性问题，从而获得更清晰的代码结构和更可靠的系统行为。
### 12.7.2 测试框架选型
本项目推荐使用以下两种测试框架之一，两者均具备优秀的 TypeScript 支持和现代化的测试体验：


| 框架 | 适用场景 | 说明 |
| --- | --- | --- |
| **Bun 内置测试运行器**（`bun test`） | 主推方案 | 与 Bun 运行时深度集成，启动速度极快，原生支持 TypeScript，无需任何额外配置即可运行测试 |
| **Vitest** | 备选方案 | 兼容 Vite 生态系统，拥有丰富的匹配器和插件系统，适合需要高级 Mock 功能或浏览器环境模拟的场景 |


选择主推 Bun 内置测试运行器的原因在于：YourBot 本身就运行在 Bun 环境上，使用同一运行时进行测试可以消除环境差异带来的假阳性和假阴性问题，同时获得极快的测试执行速度，这对于维护百分之百覆盖率的开发体验至关重要。推荐配置（`bunfig.toml`）：
```toml
[test]
coverage = true
coverageReporter = ["text", "lcov", "json-summary"]
coverageThreshold = { line = 100, branch = 100, function = 100, statement = 100 }


```

若选择 Vitest 作为测试框架，需在 `vitest.config.ts` 中进行等价配置：
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.ts',
      ],
    },
  },
});


```

### 12.7.3 测试文件命名与组织
测试文件必须与源文件**同目录放置（co-located）**，这是本项目的强制性规范。文件命名遵循以下规则：
- 源文件 `foo.ts` 对应测试文件 `foo.test.ts`
- 源文件 `bar/index.ts` 对应测试文件 `bar/index.test.ts`
- 工具类 `utils/string-helper.ts` 对应 `utils/string-helper.test.ts`目录结构示例：
```plaintext
src/
├── core/
│   ├── orchestrator.ts
│   ├── orchestrator.test.ts          # 与源文件同目录
│   ├── session-manager.ts
│   └── session-manager.test.ts
├── providers/
│   ├── claude-provider.ts
│   ├── claude-provider.test.ts
│   ├── openai-provider.ts
│   └── openai-provider.test.ts
├── mcp/
│   ├── mcp-client.ts
│   ├── mcp-client.test.ts
│   ├── tool-registry.ts
│   └── tool-registry.test.ts
└── __fixtures__/                     # 共享测试数据
    ├── mock-llm-responses.ts
    └── mock-mcp-messages.ts


```

**禁止** 将测试文件集中放到单独的 `__tests__` 或 `test/` 顶层目录。采用 co-located 模式的核心优势在于：当开发者修改某个源文件时，可以在同一目录中立即看到对应的测试文件，从而大幅降低忘记更新测试的概率。此外，这种组织方式也使得代码审查更加高效，审查者可以在同一个目录变更中同时看到功能代码和测试代码的改动。
### 12.7.4 测试结构：Arrange-Act-Assert 模式
所有测试用例必须遵循 **Arrange-Act-Assert（AAA）** 三段式模式编写。这一模式将每个测试用例清晰地划分为三个阶段：准备测试前置条件、执行被测行为、验证执行结果。通过严格遵循这一模式，可以确保测试代码具有统一的结构和极高的可读性，任何团队成员都能快速理解每个测试的意图和验证逻辑。
```typescript
import { describe, test, expect } from 'bun:test';
import { SessionManager } from './session-manager';

describe('SessionManager', () => {
  describe('createSession', () => {
    test('应该创建一个新会话并返回唯一的会话 ID', () => {
      // Arrange（准备）：构造测试所需的前置条件和输入数据
      const manager = new SessionManager({ maxSessions: 10 });
      const userId = 'user-001';

      // Act（执行）：调用被测方法，获取实际结果
      const session = manager.createSession(userId);

      // Assert（断言）：验证实际结果是否符合预期
      expect(session).toBeDefined();
      expect(session.id).toMatch(/^sess-[a-f0-9]{8}$/);
      expect(session.userId).toBe(userId);
      expect(session.status).toBe('active');
    });

    test('当会话数达到上限时应该抛出错误', () => {
      // Arrange
      const manager = new SessionManager({ maxSessions: 1 });
      manager.createSession('user-001');

      // Act & Assert（对于异常场景，执行和断言可以合并）
      expect(() => manager.createSession('user-002'))
        .toThrow('Maximum session limit reached');
    });
  });
});


```

### 12.7.5 Mock 策略
在 YourBot 平台中，以下四类外部依赖必须在单元测试中进行 Mock 处理。Mock 的根本目的是消除测试对外部环境的依赖，使测试结果完全由被测代码的逻辑决定，具有百分之百的确定性和可重复性。同时，Mock 也能极大提升测试执行速度——真实的网络请求和子进程创建需要数百毫秒甚至数秒，而 Mock 响应可以在微秒级别完成。
#### 12.7.5.1 LLM API 调用 Mock
所有对大语言模型的调用（Claude API、OpenAI API、Kimi API 等）必须完全 Mock，严禁在单元测试中发起真实的网络请求。这不仅是为了测试速度和确定性，也是为了避免在自动化测试中产生不必要的 API 费用和速率限制消耗。
```typescript
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { ClaudeProvider } from './claude-provider';

const mockFetch = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: 'msg_mock_001',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '这是模拟的 Claude 回复' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 25, output_tokens: 15 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  )
);

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockClear();
    provider = new ClaudeProvider({
      apiKey: 'sk-test-mock-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  test('应该正确调用 Claude Messages API 并解析响应', async () => {
    const result = await provider.chat([
      { role: 'user', content: '你好' },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(options.body as string)).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(result.text).toBe('这是模拟的 Claude 回复');
    expect(result.usage.totalTokens).toBe(40);
  });

  test('当 API 返回速率限制错误时应该抛出 RateLimitError', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      )
    ) as unknown as typeof fetch;

    await expect(
      provider.chat([{ role: 'user', content: '测试' }])
    ).rejects.toThrow('RateLimitError');
  });
});


```

#### 12.7.5.2 Claude CLI 子进程 Mock（Bun.spawn）
YourBot 平台通过 `Bun.spawn` 调用 Claude CLI 来执行本地的代码生成和文件操作任务。在单元测试中，必须通过 `spyOn` 拦截 `Bun.spawn` 的调用，使用预设的模拟输出替代真实的子进程执行。
```typescript
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ClaudeCLIExecutor } from './claude-cli-executor';

describe('ClaudeCLIExecutor', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn');
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  test('应该正确调用 Claude CLI 并返回解析后的输出', async () => {
    const mockStdout = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(JSON.stringify({
            type: 'result',
            result: '执行成功：已创建文件 index.ts',
            cost_usd: 0.003,
            duration_ms: 1500,
          }))
        );
        controller.close();
      },
    });

    const mockProcess = {
      pid: 12345,
      stdin: new WritableStream(),
      stdout: mockStdout,
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exitCode: Promise.resolve(0),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };

    spawnSpy.mockReturnValue(mockProcess as unknown as ReturnType<typeof Bun.spawn>);
    const executor = new ClaudeCLIExecutor({ cliPath: '/usr/local/bin/claude' });

    const result = await executor.execute({
      prompt: '创建一个 Hello World 的 TypeScript 文件',
      workDir: '/tmp/test-project',
      timeout: 30_000,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.output).toBe('执行成功：已创建文件 index.ts');
  });

  test('当 Claude CLI 进程超时时应该终止进程并抛出 TimeoutError', async () => {
    const neverResolve = new Promise<number>(() => {});
    const mockKill = mock(() => {});

    const mockProcess = {
      pid: 99999,
      stdin: new WritableStream(),
      stdout: new ReadableStream({ start(c) { } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exitCode: neverResolve,
      exited: neverResolve,
      kill: mockKill,
    };

    spawnSpy.mockReturnValue(mockProcess as unknown as ReturnType<typeof Bun.spawn>);
    const executor = new ClaudeCLIExecutor({ cliPath: '/usr/local/bin/claude' });

    await expect(
      executor.execute({ prompt: '一个非常耗时的任务', workDir: '/tmp/test', timeout: 100 })
    ).rejects.toThrow('TimeoutError');

    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
  });
});


```

#### 12.7.5.3 MCP Server 响应 Mock
MCP Server 是 YourBot 平台扩展能力的核心组件。MCP 使用 JSON-RPC 协议进行通信，在测试中需要构建模拟传输层来替代真实的 MCP Server 连接。
```typescript
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MCPClient } from './mcp-client';

function createMockTransport() {
  const pendingRequests = new Map<number, (response: unknown) => void>();
  let requestId = 0;
  return {
    send: mock(async (method: string, params?: unknown) => {
      const id = ++requestId;
      return new Promise((resolve) => {
        pendingRequests.set(id, resolve);
        queueMicrotask(() => {
          const handler = pendingRequests.get(id);
          if (handler) {
            handler(getMockResponse(method, params));
            pendingRequests.delete(id);
          }
        });
      });
    }),
    close: mock(async () => {}),
  };
}

function getMockResponse(method: string, params?: unknown): unknown {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      };
    case 'tools/list':
      return {
        tools: [
          { name: 'file_read', description: '读取文件内容', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
          { name: 'file_write', description: '写入文件', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        ],
      };
    case 'tools/call':
      const tp = params as { name: string; arguments: Record<string, unknown> };
      if (tp.name === 'file_read') return { content: [{ type: 'text', text: '模拟文件内容' }], isError: false };
      return { content: [{ type: 'text', text: `未知工具: ${tp.name}` }], isError: true };
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

describe('MCPClient', () => {
  let client: MCPClient;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(async () => {
    transport = createMockTransport();
    client = new MCPClient({ transport: transport as unknown as MCPTransport });
    await client.initialize();
  });

  test('应该正确获取可用工具列表', async () => {
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('file_read');
  });

  test('应该正确调用 MCP 工具并返回结果', async () => {
    const result = await client.callTool('file_read', { path: '/project/src/index.ts' });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('模拟文件内容');
  });
});


```

#### 12.7.5.4 文件系统 Mock
对于涉及文件读写操作的功能模块，测试中应当使用临时目录来创建隔离的测试环境。
```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from './workspace-manager';

describe('WorkspaceManager', () => {
  let tempDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yourbot-test-'));
    manager = new WorkspaceManager({ rootDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('应该在工作区中正确创建项目目录结构', async () => {
    await manager.initializeProject('my-project');
    const projectDir = join(tempDir, 'my-project');
    expect(await Bun.file(join(projectDir, 'package.json')).exists()).toBe(true);
  });
});


```

### 12.7.6 CI 流水线集成
覆盖率检查必须集成到 CI/CD 流水线中，作为代码合并的硬性门禁条件。
```yaml
name: Test & Coverage Gate
on:
  pull_request:
    branches: [main, develop]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Run tests with coverage
        run: bun test --coverage
      - name: Verify 100% coverage
        run: |
          COVERAGE=$(cat coverage/coverage-summary.json | jq '.total | [.lines.pct, .branches.pct, .functions.pct, .statements.pct] | min')
          if (( $(echo "$COVERAGE < 100" | bc -l) )); then
            echo "::error::覆盖率低于 100%"
            exit 1
          fi


```

### 12.7.7 测试编写最佳实践
1. **测试命名规范**：使用中文描述测试意图，格式为「应该 + 预期行为 + 条件」。
1. **单一职责原则**：每个测试用例只验证一个行为点。
1. **避免测试间耦合**：测试用例之间绝不共享可变状态。
1. **优先使用结构化匹配器**：对复杂对象使用 `toEqual` 和 `toMatchObject`。
1. **异步测试显式等待**：所有异步操作必须使用 `await` 显式等待。
1. **测试数据工厂模式**：频繁使用的测试数据抽取为工厂函数放入 `__fixtures__/` 目录。
1. **快照测试慎用**：仅在输出结构稳定且审查快照差异有意义的场景使用。
1. **边界条件必须覆盖**：每个公开方法需编写边界条件测试用例。
