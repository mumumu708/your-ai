# DD-005: Agent 引擎

- **状态**: Implemented
- **创建日期**: 2026-03-06

## 背景

YourBot 需要根据任务复杂度选择不同的 LLM 后端执行。简单任务（问候、快速问答）不需要 Claude 的完整能力，使用轻量 LLM 可以降低成本和延迟；复杂任务（工具调用、多步推理）需要 Claude Code 的完整能力。

## 架构总览

```
              AgentRuntime.execute()
                     │
              TaskClassifier.classify()
              ┌──────┴──────┐
              │              │
         simple         complex
              │              │
     LightLLMClient   ClaudeAgentBridge
     (OpenAI API)     (claude CLI subprocess)
              │              │
              └──────┬──────┘
                     │
            AgentLifecycleManager
              (状态机跟踪)
                     │
           ProcessSecurityManager
            (进程安全控制)
```

## 核心组件

### 1. AgentRuntime (src/kernel/agents/agent-runtime.ts)

**职责**: 统一 Agent 执行入口，根据分类结果路由到不同后端。

**依赖注入**: 所有依赖可选（支持部分配置）

```typescript
interface AgentRuntimeDeps {
  classifier?: TaskClassifier | null;
  claudeBridge?: ClaudeAgentBridge | null;
  lightLLM?: LightLLMClient | null;
}
```

**执行流程**:

```
execute(params)
  ├── 无 classifier → 默认走 executeComplex
  ├── getLastUserMessage() → 提取最新用户消息
  ├── classifier.classify(message, context) → simple / complex
  │     context 包含: hasRecentToolUse, userId
  ├── simple → executeSimple()
  │     ├── 无 lightLLM → 降级到 executeComplex
  │     ├── 支持流式: lightLLM.stream() → 逐 chunk 回调
  │     └── 非流式: lightLLM.complete() → 完整响应
  └── complex → executeComplex()
        ├── 无 claudeBridge → 返回占位消息
        └── claudeBridge.execute({
              sessionId, messages, systemPrompt,
              signal, onStream, cwd, claudeSessionId
            })
```

**返回类型**:

```typescript
interface EnhancedAgentResult {
  content: string;
  tokenUsage: { inputTokens, outputTokens, totalCost };
  complexity: 'simple' | 'complex';
  channel: 'agent_sdk' | 'light_llm';
  classificationCostUsd: number;
  toolsUsed?: string[];
  claudeSessionId?: string;
}
```

### 2. ClaudeAgentBridge (src/kernel/agents/claude-agent-bridge.ts)

**职责**: 封装 Claude CLI 子进程，管理会话续接、流式解析和工具追踪。

**关键常量**:
- `DEFAULT_MODEL = 'sonnet'`
- `MAX_CONCURRENT_SESSIONS = 20`
- `MAX_PROMPT_TOKENS = 80_000`
- `CHARS_PER_TOKEN = 4`

**执行流程**:

```
execute(params)
  ├── 检查并发限制 (activeSessions < maxConcurrent)
  ├── 判断模式: resume vs fresh
  │     ├── resume: 只发最新消息 + --resume <claudeSessionId>
  │     └── fresh: buildPrompt() 构建完整 prompt
  ├── CLI 参数: -p <prompt> --output-format stream-json --verbose --model <model>
  ├── 可选: --system-prompt <systemPrompt>
  ├── 环境变量清洗: 过滤 CLAUDECODE（避免嵌套检测）
  ├── Bun.spawn([claudePath, ...args], { env, cwd, stdout: 'pipe' })
  ├── AbortSignal → proc.kill()
  ├── processStream() → 解析 stream-json 输出
  ├── resume 失败 → executeWithoutResume() 回退
  └── 异常 → YourBotError(LLM_API_ERROR)
```

**Prompt 构建** (buildPrompt):

```
单条消息 → 直接返回 content
多条消息 → 从新到旧累积，直到 80k tokens 预算用尽
         → 格式: "[前N条消息已省略]\n\n用户: ...\n\n助手: ..."
```

**Stream 解析** (processStream):

逐行解析 Claude CLI 的 stream-json 输出：
- `type='assistant'` → 提取 text blocks → onStream('text_delta')，收集 tool_use names
- `type='result'` → 提取 usage (inputTokens/outputTokens/costUsd)，捕获 session_id

**会话续接**:
- 首次对话无 claudeSessionId → fresh 模式
- 后续消息携带 claudeSessionId → resume 模式（只发最新消息）
- resume 失败 → 自动回退到 fresh 模式重试

### 3. LightLLMClient (src/kernel/agents/light-llm-client.ts)

**职责**: 轻量 LLM 客户端，兼容 OpenAI API。

**配置** (环境变量):
- `LIGHT_LLM_API_KEY` — API 密钥
- `LIGHT_LLM_BASE_URL` — API 地址 (默认: `https://api.openai.com/v1`)
- `LIGHT_LLM_MODEL` — 默认模型 (默认: `gpt-4o-mini`)

**功能**:

| 方法 | 用途 | 参数 |
|------|------|------|
| `complete(request)` | 同步补全 | messages, model?, maxTokens=1024, temperature=0.7 |
| `stream(request)` | 流式补全 (AsyncGenerator) | 同上 + SSE 解析 |
| `estimateCost(model, prompt, completion)` | 成本估算 | 内置模型价格表 |

**支持的模型成本** (每百万 token):
- gpt-4o-mini: input $0.15 / output $0.6
- deepseek-chat: input $0.14 / output $0.28
- qwen-turbo: input $0.1 / output $0.3

### 4. AgentLifecycleManager (src/kernel/agents/agent-lifecycle.ts)

**职责**: 追踪请求生命周期状态机，收集指标。继承 EventEmitter。

**状态机**:

```
IDLE → CLASSIFYING → AGENT_SDK_PROCESSING → COMPLETING → COMPLETED
                   → LIGHT_LLM_PROCESSING → COMPLETING → COMPLETED
任何状态 → ERROR (强制转换)
```

**关键方法**:

| 方法 | 触发时机 |
|------|---------|
| `startLifecycle(sessionId, userMessage)` | 请求开始 |
| `markClassified(requestId, result)` | 分类完成，路由到对应处理器 |
| `markCompleting(requestId)` | 处理即将完成 |
| `markCompleted(requestId)` | 成功完成 |
| `markError(requestId, error)` | 出错（可从任何状态转入）|
| `abortLifecycle(requestId)` | 用户取消 |
| `cleanup()` | 清理 5 分钟前完成的上下文 |

**事件发射**:
- `lifecycle:transition` — `{ requestId, from, to, timestamp }`
- `lifecycle:metrics` — `{ totalDurationMs, classificationDurationMs, processingDurationMs, channel, complexity, success }`

### 5. ProcessSecurityManager (src/kernel/agents/process-security.ts)

**职责**: 子进程安全控制——并发限制、超时、环境变量过滤。

**默认配置**:
- `maxProcesses: 10`
- `processTimeoutMs: 300_000` (5 分钟)
- `allowedEnvKeys: ['PATH', 'HOME', 'LANG', 'TERM', 'NODE_ENV']`

**环境变量过滤**:

屏蔽模式: `/password/i`, `/secret/i`, `/private_key/i`, `/credential/i`, `/token(?!s_)/i`

```
buildSecureEnv(apiKey, sessionId)
  → 白名单过滤 process.env
  → 屏蔽敏感变量
  → 注入: ANTHROPIC_API_KEY, SESSION_ID, NODE_ENV
```

**进程注册**: 每个注册的进程设置超时定时器，超时自动 SIGTERM。

## TaskClassifier 两层分类

```
classify(message, context)
  ├── context.hasRecentToolUse → 直接判定 complex (置信度 0.8)
  ├── 第一层: ruleClassify(message) — 正则匹配
  │     ├── SIMPLE_PATTERNS → simple (问候/感谢/简单问答)
  │     └── COMPLEX_PATTERNS → complex (分析/代码/文件操作)
  └── 第二层: llmClassify(message) — LLM 兜底 (模糊地带)
```

## 关键设计决策

1. **分类路由** — 简单/复杂两条路径，成本差异可达 10x+
2. **会话续接** — Claude CLI 的 `--resume` 模式复用上下文，减少 token 消耗
3. **自动降级** — resume 失败自动重试 fresh；无 LLM 客户端返回占位消息
4. **环境隔离** — 子进程环境变量白名单过滤，防止敏感信息泄漏
5. **流式优先** — 两条路径都支持 StreamEvent 回调

## 文件清单

| 文件 | 职责 |
|------|------|
| src/kernel/agents/agent-runtime.ts | 统一执行入口 + 复杂度路由 |
| src/kernel/agents/claude-agent-bridge.ts | Claude CLI 子进程封装 |
| src/kernel/agents/light-llm-client.ts | OpenAI 兼容 API 客户端 |
| src/kernel/agents/agent-lifecycle.ts | 生命周期状态机 + 指标 |
| src/kernel/agents/process-security.ts | 进程安全控制 |
| src/kernel/classifier/task-classifier.ts | 两层任务分类器 |
| src/kernel/classifier/classifier-types.ts | 分类相关类型 |
