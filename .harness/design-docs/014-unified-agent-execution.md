# DD-014: 统一执行 Agent

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-12
- **上游**: [DD-011](011-architecture-upgrade-v2.md)

## 背景

当前 `AgentRuntime.execute()` 根据 `complexity` 分叉到两条完全独立的代码路径：

```
simple  → LightLLMClient.chat()        // OpenAI 兼容 API，无工具
complex → ClaudeAgentBridge.run()       // Claude CLI 子进程，完整工具链
```

问题：
1. **两条代码路径需要分别维护**：system prompt 注入、流式处理、错误处理都有两套实现
2. **Simple 路径能力受限**：LightLLM 没有工具调用能力，无法使用 memory/skill/file 等工具
3. **模式切换是代码分支而非配置变化**：违背了 "everything's context engineering" 的原则
4. **单一 Agent 供应商风险**：Claude Code 不可用时系统完全瘫痪

## 目标

1. 两层架构：Intelligence Gateway（快速预处理）+ Agent Layer（完整 agency）
2. Agent Layer 统一为 `AgentBridge` 接口，Claude Code 为主，Codex 为 fallback
3. LightLLM 从"劣化版 Agent"重新定位为"快速预处理层引擎"
4. Agent 行为差异通过 context engineering 实现，不是代码分叉

## 非目标

- 不自建 ReAct/Tool-use 循环
- 不自建 compaction/context 管理（Claude Code 内部的 6 层 context engine 已足够）
- 不实现多 agent 协作（Claude Code 内部的 subagent/delegation 能力已足够）

## 方案

### 1. 两层架构

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Intelligence Gateway（LightLLM 驱动）       │
│                                                      │
│ 职责：快速预处理，不需要工具和 agency 的事情          │
│  • 任务分类（现有 TaskClassifier 已在用 LightLLM）    │
│  • 任务聚合（DD-013 的队列消息合并）                  │
│  • 快速问答拦截（不需要工具的简单任务）               │
│  • 意图澄清（模糊指令的确认提问）                    │
│                                                      │
│ 特点：无工具、无 session、无 system prompt 开销       │
│       单次 LLM 调用，< 1s，< $0.001                  │
└──────────────┬──────────────────────────────────────┘
               │ 需要 agency 的任务向下传递
               ▼
┌─────────────────────────────────────────────────────┐
│ Layer 2: Agent Layer（统一 AgentBridge 接口）         │
│                                                      │
│  ┌─────────────────┐    ┌──────────────────┐        │
│  │ Claude Code      │    │ Codex             │        │
│  │ (Primary)        │───→│ (Fallback)        │        │
│  │                  │    │                   │        │
│  │ • 完整工具链     │    │ • 完整工具链      │        │
│  │ • Memory/Skill   │    │ • Memory/Skill    │        │
│  │ • Long-horizon   │    │ • Long-horizon    │        │
│  └──────────────────┘    └──────────────────┘        │
└─────────────────────────────────────────────────────┘
```

**核心原则**：LightLLM 和 Claude Code/Codex 不是同一层级。LightLLM 是快速预处理器，不是降级版 Agent。一旦任务需要 agency（工具、多步、记忆），必须下沉到 Agent Layer。

### 2. Intelligence Gateway

```typescript
class IntelligenceGateway {
  constructor(
    private lightLlm: LightLLMClient,
    private classifier: TaskClassifier,
    private aggregator: QueueAggregator,
    private agentLayer: AgentBridge,    // Layer 2
  ) {}

  async handle(task: Task): Promise<TaskResult> {
    // Step 1: 分类（现有逻辑，LightLLM 驱动）
    const classify = await this.classifier.classify(task.message);
    task.classifyResult = classify;

    // Step 2: 快速拦截判断
    if (this.canHandleDirectly(classify, task)) {
      return this.quickAnswer(task);
    }

    // Step 3: 需要 agency → 下沉到 Agent Layer
    return this.dispatchToAgent(task);
  }

  private canHandleDirectly(classify: UnifiedClassifyResult, task: Task): boolean {
    // 严格条件：只拦截明确不需要 agency 的任务
    return classify.complexity === 'simple'
        && classify.taskType === 'chat'
        && !this.mightNeedTools(task.message.content)
        && !this.mightNeedMemory(task.message.content)
        && !this.hasAttachments(task.message);
  }

  private mightNeedTools(content: string): boolean {
    // 启发式检测：提到文件操作、搜索、计算、代码等
    const toolIndicators = [
      /文件|文档|代码|搜索|查[找询]|计算|分析|创建|修改|删除/,
      /file|code|search|create|modify|delete|calculate|analyze/i,
      /帮我|请你|能不能|可以.*吗/,  // 指令性请求
    ];
    return toolIndicators.some(r => r.test(content));
  }

  private mightNeedMemory(content: string): boolean {
    // 需要历史上下文的请求
    const memoryIndicators = [
      /之前|上次|上周|昨天|记得|提到过|讨论过|我说过/,
      /previously|last time|remember|mentioned|discussed/i,
    ];
    return memoryIndicators.some(r => r.test(content));
  }

  private async quickAnswer(task: Task): Promise<TaskResult> {
    // 精简 prompt：只有身份 + 基本风格约束
    // 无 AIEOS 全量加载、无 Memory 检索、无 Skill 索引
    const response = await this.lightLlm.chat(
      QUICK_ANSWER_PROMPT,    // ~200 tokens：身份 + 语言 + 风格
      task.message.content,
    );

    return {
      success: true,
      taskId: task.id,
      completedAt: Date.now(),
      data: { content: response, handledBy: 'gateway' },
    };
  }

  private async dispatchToAgent(task: Task): Promise<TaskResult> {
    // 完整的 context engineering pipeline → Agent Layer
    const systemPrompt = task.session.frozenSystemPrompt;
    const turnContext = await this.buildTurnContext(task);

    return this.agentLayer.execute({
      systemPrompt: systemPrompt.content,
      prependContext: turnContext,
      userMessage: task.message.content,
      sessionId: task.session.id,
      claudeSessionId: task.session.claudeSessionId,
      workspacePath: task.session.workspacePath,
      mcpConfig: this.mcpConfigBuilder.build(task),
      executionMode: task.classifyResult!.executionMode,
      classifyResult: task.classifyResult!,
      signal: task.signal,
      streamCallback: this.getStreamCallback(task.session),
    });
  }
}

// 精简 prompt：不加载 AIEOS，不检索 memory，不注入 skill
const QUICK_ANSWER_PROMPT = `你是 YourBot，一个个人 AI 助手。
简洁直接地回答用户问题。自动检测并使用用户的语言。
如果问题需要查询记忆、使用工具或深入分析，回复"我需要更仔细地处理这个问题"。`;
```

**安全阀**：`QUICK_ANSWER_PROMPT` 最后一句是关键 — 如果 LightLLM 判断自己答不好，它会回复一个特定短语，Gateway 检测到后自动降级到 Agent Layer 重新处理。

```typescript
private async quickAnswer(task: Task): Promise<TaskResult> {
  const response = await this.lightLlm.chat(QUICK_ANSWER_PROMPT, task.message.content);

  // 安全阀：LightLLM 自认为答不好，降级到 Agent Layer
  if (response.includes('我需要更仔细地处理这个问题')) {
    return this.dispatchToAgent(task);
  }

  return { success: true, /* ... */ };
}
```

### 3. Agent Layer — 统一 AgentBridge 接口

```typescript
interface AgentBridge {
  execute(params: AgentExecuteParams): Promise<AgentResult>;
  appendMessage(sessionKey: string, content: string): Promise<void>;
  abort(sessionKey: string): Promise<void>;
}

interface AgentExecuteParams {
  // Context Engineering 输入
  systemPrompt: string;
  prependContext: string;
  userMessage: string;

  // Session 管理
  sessionId: string;
  claudeSessionId?: string;
  workspacePath?: string;

  // Tool 配置
  mcpConfig: McpConfig;
  toolWhitelist?: string[];

  // 执行控制
  signal?: AbortSignal;
  streamCallback?: (event: StreamEvent) => Promise<void>;
  maxTurns?: number;

  // 元数据
  executionMode: ExecutionMode;
  classifyResult: UnifiedClassifyResult;
}

interface AgentResult {
  content: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
  toolsUsed?: string[];
  claudeSessionId?: string;
  turnsUsed?: number;
  finishedNaturally: boolean;
  handledBy: 'claude' | 'codex';
}
```

### 4. Fallback：Claude Code → Codex

```typescript
class AgentBridgeWithFallback implements AgentBridge {
  constructor(
    private claude: ClaudeAgentBridge,
    private codex: CodexAgentBridge,
  ) {}

  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    try {
      const result = await this.claude.execute(params);
      return { ...result, handledBy: 'claude' };
    } catch (error) {
      if (this.isProviderUnavailable(error)) {
        logger.warn('Claude Code unavailable, falling back to Codex', {
          error: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
        });
        const adapted = this.adaptForCodex(params);
        const result = await this.codex.execute(adapted);
        return { ...result, handledBy: 'codex' };
      }
      throw error;
    }
  }

  private isProviderUnavailable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /ENOENT|not found|rate.?limit|quota|503|502|timeout/i.test(error.message);
  }

  private adaptForCodex(params: AgentExecuteParams): AgentExecuteParams {
    // Codex 可能需要的适配：
    // - system prompt 格式差异
    // - MCP 配置映射
    // - 工具名称映射
    return {
      ...params,
      // codex-specific adjustments
    };
  }

  async appendMessage(sessionKey: string, content: string): Promise<void> {
    // 优先尝试 Claude，失败尝试 Codex
    try {
      await this.claude.appendMessage(sessionKey, content);
    } catch {
      await this.codex.appendMessage(sessionKey, content);
    }
  }

  async abort(sessionKey: string): Promise<void> {
    // 两个都尝试取消
    await Promise.allSettled([
      this.claude.abort(sessionKey),
      this.codex.abort(sessionKey),
    ]);
  }
}
```

### 5. CodexAgentBridge 实现

```typescript
class CodexAgentBridge implements AgentBridge {
  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    // Codex CLI 调用（类似 Claude Code 的 spawn 模式）
    const args = this.buildCliArgs(params);
    const proc = spawn('codex', args, {
      cwd: params.workspacePath || this.defaultWorkspace,
      env: this.buildEnv(params),
    });

    if (params.streamCallback) {
      return this.handleStreaming(proc, params);
    }
    return this.handleBatch(proc, params);
  }

  // appendMessage / abort 同 ClaudeAgentBridge 模式
}
```

### 6. Context Engineering 驱动模式切换

Agent Layer 内部没有 simple/complex 分叉。行为差异完全通过输入配置：

| 任务形态 | System Prompt 调整 | Tool 配置 | 执行参数 |
|---------|-------------------|----------|---------|
| 工具辅助问答 | 标准 protocol | memory + 相关 MCP tools | maxTurns=10 |
| Deep Research | 标准 + planning 指引 | 全量 tools + web_search | maxTurns=50 |
| Coding/Harness | 标准 + 编码规范 | 全量 tools + file system | maxTurns=100 |
| 后台反思 | 反思专用 prompt | memory + skill_manage + session_search | 无 streamCallback |
| 学习引导 | 标准 + 教学 skill 提示 | memory + web_search | maxTurns=30 |

注意：简单问答不在这个表里 — 它被 Gateway 拦截了，不进入 Agent Layer。

#### Task Guidance 构建

```typescript
class TaskGuidanceBuilder {
  build(classify: UnifiedClassifyResult, context: TaskContext): string {
    const parts: string[] = [];

    parts.push(`任务类型：${classify.taskType}（${classify.executionMode}）`);

    switch (classify.executionMode) {
      case 'sync':
        parts.push('简洁直接回答。');
        break;
      case 'async':
        parts.push('这是后台任务。完成后结果将推送给用户。');
        break;
      case 'long-horizon':
        parts.push('这是长时间任务。定期输出进展，用户可能中途追加指令。');
        parts.push('建议：先分解步骤，逐步执行，必要时 delegate 子任务。');
        break;
    }

    const matched = this.matchSkills(classify, context);
    if (matched.length > 0) {
      parts.push(`推荐 skill: ${matched.join(', ')}。请先 skill_view 加载。`);
    }

    if (classify.taskType === 'harness') {
      parts.push(`工作目录：${context.workspacePath}`);
      parts.push('完成后运行项目检查命令验证。');
    }

    return parts.join('\n');
  }
}
```

#### MCP Config 动态生成

```typescript
class McpConfigBuilder {
  build(task: Task): McpConfig {
    const servers: McpServerConfig[] = [];
    const { executionMode, taskType } = task.classifyResult!;

    // 基础：memory server 始终可用
    servers.push(this.memoryServer(task.session.userId));

    // 按需
    if (executionMode !== 'sync' || taskType === 'harness') {
      servers.push(this.skillServer());
    }
    if (taskType === 'scheduled' || taskType === 'automation') {
      servers.push(this.schedulerServer());
    }
    if (this.needsChannelTools(taskType)) {
      servers.push(this.feishuServer());
    }

    // 用户自定义
    servers.push(...this.userMcpServers(task.session.userId));

    return { mcpServers: servers };
  }
}
```

### 7. ClaudeAgentBridge 重构

```typescript
class ClaudeAgentBridge implements AgentBridge {
  async execute(params: AgentExecuteParams): Promise<AgentResult> {
    const args = this.buildCliArgs(params);
    const proc = spawn('claude', args, {
      cwd: params.workspacePath || this.defaultWorkspace,
      env: this.buildEnv(params),
    });

    if (params.streamCallback) {
      return this.handleStreaming(proc, params);
    }
    return this.handleBatch(proc, params);
  }

  private buildCliArgs(params: AgentExecuteParams): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--system-prompt', params.systemPrompt,
    ];

    if (params.claudeSessionId) {
      args.push('--session-id', params.claudeSessionId);
    }
    if (params.mcpConfig) {
      args.push('--mcp-config', this.writeTempMcpConfig(params.mcpConfig));
    }
    if (params.maxTurns) {
      args.push('--max-turns', String(params.maxTurns));
    }

    const fullPrompt = [params.prependContext, params.userMessage]
      .filter(Boolean).join('\n\n');
    args.push('-p', fullPrompt);

    return args;
  }

  async appendMessage(sessionKey: string, content: string): Promise<void> {
    const sessionId = this.activeSessionIds.get(sessionKey);
    if (!sessionId) throw new Error('No active session');
    await this.executeInSession(sessionId, content);
  }

  async abort(sessionKey: string): Promise<void> {
    const proc = this.activeProcesses.get(sessionKey);
    if (proc) proc.kill('SIGTERM');
  }
}
```

### 8. 迁移路径

```
Phase 1: 接口统一
├─ 定义 AgentBridge 接口
├─ ClaudeAgentBridge 实现新接口
├─ CodexAgentBridge 实现新接口
├─ AgentBridgeWithFallback 包装 Claude → Codex
└─ 移除 AgentRuntime 中的 complexity 分叉

Phase 2: Gateway 拆分
├─ IntelligenceGateway 实现
├─ LightLLM 从 Agent 层移到 Gateway 层
├─ 拦截规则调优（canHandleDirectly + 安全阀）
└─ CentralController 切换到 Gateway → Agent 两层调用

Phase 3: Context Engineering
├─ SystemPromptBuilder 替换 KnowledgeRouter（DD-018）
├─ TaskGuidanceBuilder 实现
├─ McpConfigBuilder 实现
└─ 冻结快照集成
```

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/agents/agent-bridge.ts` | 新增 — 统一接口定义 |
| `src/kernel/agents/claude-agent-bridge.ts` | 重构 — 实现新接口 |
| `src/kernel/agents/codex-agent-bridge.ts` | 新增 — Codex 实现 |
| `src/kernel/agents/agent-bridge-fallback.ts` | 新增 — Claude → Codex 容错 |
| `src/kernel/agents/intelligence-gateway.ts` | 新增 — 快速预处理层 |
| `src/kernel/agents/agent-runtime.ts` | 删除 — 职能拆分到 Gateway + AgentBridge |
| `src/kernel/agents/light-llm-client.ts` | 保留 — 重新定位为 Gateway 引擎 |
| `src/kernel/agents/mcp-config-builder.ts` | 新增 — 动态 MCP 配置 |
| `src/kernel/agents/task-guidance-builder.ts` | 新增 — 任务指引生成 |
| `src/kernel/central-controller.ts` | 重构 — 使用 IntelligenceGateway |

## 备选方案

### A. your-ai 自建 agent 循环

不依赖 Claude Code CLI，自己实现 Tool-use 循环，直接调 Claude API。

优势：完全控制执行过程
劣势：
- 巨大的工程量（tool 管理、context 管理、compaction、subagent）
- 失去 Claude Code 的持续更新（6 层 context engine、/dream、/simplify 等）
- 重复造轮子

**决策**：不自建。Claude Code 作为 agent 本体，your-ai 做 harness。

### B. LightLLM 作为 Agent Layer fallback

Claude Code 不可用时退化到 LightLLM。

问题：
- LightLLM 无工具能力，退化后用户体验断崖式下降
- 不如用同样具备完整 agency 能力的 Codex 做 fallback

**决策**：Codex 作为 Agent Layer fallback。LightLLM 重新定位为 Gateway 层引擎。

### C. 直接删除 LightLLM

所有任务都走 Agent Layer。

问题：
- "今天几号"这种问题也要 spawn Claude Code 子进程，成本和延迟不合理
- 分类和聚合已经在用 LightLLM，删除后这些能力也要迁移到 Claude Code

**决策**：保留 LightLLM 但重新定位。它不是 Agent，是 Gateway 的快速处理引擎。

## 验收标准

- [ ] 两层架构就位：Gateway + Agent Layer
- [ ] Gateway 正确拦截不需要 agency 的简单任务
- [ ] Gateway 安全阀正常工作（LightLLM 回复不确定时降级到 Agent Layer）
- [ ] Agent Layer 所有任务通过统一 AgentBridge 接口执行
- [ ] Claude Code 不可用时自动 fallback 到 Codex
- [ ] 不同任务类型通过 context engineering 配置差异化行为
- [ ] MCP 配置按任务类型动态生成
- [ ] `bun run check:all` 通过

## 参考

- hermes-agent `run_agent.py` — 单一 `AIAgent.run_conversation()` 入口
- Harrison Chase "Everything's context engineering"
- Claude Code 源码 — system prompt 静态/动态分区、skill 注入机制
- [DD-011](011-architecture-upgrade-v2.md) — 两层架构总设计
