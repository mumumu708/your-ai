# 第4章 Agent 运行时引擎
> **架构变更说明**：KuaiBot 的 Agent 运行时引擎已从早期的「自建 Agentic Loop」迁移至「混合推理架构（Claude Agent SDK + 廉价模型分流）」。这一决策的完整论证见 §17 架构决策记录。核心动机在于：自建 Loop 在工具编排、上下文压缩、错误恢复等方面的工程复杂度远超预期，而 Claude Agent SDK 已将这些能力内置为一等公民。与此同时，并非所有用户请求都需要 Agent 级推理——简单问答、状态查询等场景由廉价模型（LightLLM 通道）处理，可将平均推理成本降低 60%~75%。本章将详细阐述混合推理架构的内核设计、双通道运行模式、Agent 生命周期管理、会话内核模块、工作空间管理、容器配置、配置系统以及上下文管理策略。
---

## 4.1 核心设计
### 4.1.1 设计原则
> **廉价模型做门卫和杂活，Claude Agent SDK 做高价值重活，YourBot 做编排和生态集成。**三条核心原则：
1. **前置分类用廉价模型** — 任务复杂度判断本身不用 Claude，节省分类成本
1. **简单任务走廉价模型** — 闲聊、翻译、摘要等用 DeepSeek-V3/Qwen-Turbo，单次成本 < $0.001
1. **复杂任务走 Claude Agent SDK** — 需要工具调用、多步推理、代码执行的任务才启用 Agent 能力
### 4.1.2 混合推理架构下的 Kernel 层结构
在旧架构中，Kernel 层以 `agents/` 目录为核心，包含自建的 `agent-runtime.ts`、`tool-executor.ts`、`stream-handler.ts` 等模块。迁移至混合推理架构后，Kernel 层重新组织为四个核心子模块：
```plaintext
├── classifier/                    # 任务分类器
│   ├── task-classifier.ts         # 分类主逻辑
│   ├── intent-schema.ts           # 意图定义 & 阈值配置
│   ├── classifier-prompt.ts       # 分类 prompt 模板
│   └── routing-rules.ts           # 静态路由规则（正则 + 关键词）
├── llm/                           # 廉价模型通道（LightLLM）
│   ├── light-llm-client.ts        # LightLLM 调用封装
│   ├── light-llm-context.ts       # 轻量上下文管理
│   ├── response-formatter.ts      # 输出格式化
│   └── providers/                 # 多模型提供商适配
│       ├── deepseek-provider.ts
│       ├── qwen-provider.ts
│       └── provider-interface.ts
├── mcp/                           # MCP 工具服务层
│   ├── mcp-server-manager.ts      # MCP Server 生命周期管理
│   ├── tool-registry.ts           # 工具注册表
│   └── tool-schemas/              # 各工具的 JSON Schema
├── agent-bridge/                  # Claude Agent SDK 桥接层
│   ├── claude-agent-bridge.ts     # Agent SDK 主桥接
│   ├── session-adapter.ts         # KuaiBot Session ↔ SDK Session 适配
│   ├── tool-provider.ts           # 向 Agent SDK 注册 MCP 工具
│   ├── event-stream.ts            # SDK 事件流 → KuaiBot 事件总线
│   └── compaction-hooks.ts        # 上下文压缩钩子
├── session/                       # 会话内核模块
│   ├── session-store.ts           # 持久化存储
│   ├── session-scheduler.ts       # 并发调度
│   └── session-types.ts           # 类型定义
├── workspace/                     # 工作空间管理
│   ├── workspace-manager.ts
│   └── claude-project-init.ts     # .claude/ 目录初始化
├── config/                        # 配置系统
│   ├── agent-config.ts
│   └── feature-flags.ts
└── central-controller.ts          # 中央控制器（路由决策入口）```

相比旧架构，关键变化如下：

| 旧架构模块 | 新架构模块 | 变更原因 |
|---|---|---|
| `agents/agent-runtime.ts` | `agent-bridge/claude-agent-bridge.ts` | Agentic Loop 由 SDK 内置，KuaiBot 只需桥接 |
| `agents/tool-executor.ts` | Agent SDK 内置工具执行 + `mcp/` | 工具执行委托给 SDK，MCP 层负责注册 |
| `agents/stream-handler.ts` | `agent-bridge/event-stream.ts` | 流式输出由 SDK 事件流驱动 |
| （不存在） | `classifier/` | 新增：任务分类器实现智能路由 |
| （不存在） | `llm/` | 新增：廉价模型通道处理简单任务 |
```

### 4.1.2 双通道运行模式
```plaintext
用户消息
  │
  ▼
Gateway (飞书/Telegram/Web)
  │
  ▼
CentralController
  │
  ▼
┌─────────────────────────────────┐
│    前置任务复杂度分类器           │
│    (DeepSeek-V3, ~$0.0003/次)   │
│                                 │
│  ┌──────────┐   ┌────────────┐  │
│  │ 规则预筛  │ → │ LLM 分类   │  │
│  │ (零成本)  │   │ (模糊地带)  │  │
│  └──────────┘   └────────────┘  │
└──────────┬──────────┬───────────┘
           │          │
      simple      complex
           │          │
           ▼          ▼
┌──────────────┐ ┌─────────────────────┐
│  廉价模型     │ │  Claude Agent SDK    │
│  直接 API 调用│ │  query()             │
│              │ │                     │
│  DeepSeek-V3 │ │  ┌─ SKILL.md 动态技能 │
│  Qwen-Turbo  │ │  ├─ CLAUDE.md 记忆   │
│  GPT-4o-mini │ │  ├─ 自定义 MCP Server │
│              │ │  └─ 内置工具          │
│  ~$0.001/次  │ │     Read/Write/Bash  │
│              │ │                     │
│              │ │  ~$0.02-0.08/次     │
└──────┬───────┘ └────────────┬────────┘
       │                    │
       └────────┬───────────┘
                │
                ▼
        StreamAdapter → 飞书卡片/Telegram/Web
```

混合推理架构的核心在于**双通道分流**：复杂任务走 Agent SDK 通道获得完整的工具使用与多步推理能力；简单任务走 LightLLM 通道以极低成本快速响应。
#### 通道对比


| 维度 | Agent SDK 通道 | LightLLM 通道 |
| --- | --- | --- |
| **适用场景** | 多步骤任务、代码生成/修改、文件操作、需要工具调用的复杂问答 | 简单问答、知识检索、状态查询、闲聊、格式转换 |
| **平均成本** | ~$0.03 / 请求（含工具调用） | ~$0.001 / 请求 |
| **响应延迟** | 2~15s（取决于工具调用轮数） | 0.3~1.5s |
| **工具能力** | 完整 MCP 工具集 + Bash + 文件读写 | 无工具调用（纯文本生成） |
| **上下文管理** | Agent SDK 内置 Compaction，自动管理 | KuaiBot 自管理，滑动窗口策略 |
| **模型** | Claude Sonnet 4 / Claude Opus 4.5 | DeepSeek-V3 / Qwen-72B（可配置） |
| **错误恢复** | SDK 内置重试 + 自修复 | 简单重试，无自修复 |


#### CentralController 路由逻辑
### 
```typescript
// src/kernel/central-controller.ts (混合架构重构)
import { TaskClassifier, TaskComplexity } from './task-classifier.js';
import { ClaudeAgentBridge } from './agents/claude-agent-bridge.js';
import { LightLLMClient } from './agents/light-llm-client.js';
import { BudgetManager } from '../budget/budget-manager.js';
import { UsageTracker } from '../budget/usage-tracker.js';
import { SessionManager } from './sessioning/session-manager.js';
import { Logger } from '../utils/logger.js';

export class CentralController {
  private static instance: CentralController | null = null;

  private classifier: TaskClassifier;
  private agentBridge: ClaudeAgentBridge;
  private lightLLM: LightLLMClient;
  private budgetManager: BudgetManager;
  private usageTracker: UsageTracker;
  private sessionManager: SessionManager;
  private logger = new Logger('CentralController');

  private constructor() {
    this.lightLLM = new LightLLMClient();
    this.classifier = new TaskClassifier(this.lightLLM);
    this.usageTracker = new UsageTracker();
    this.budgetManager = new BudgetManager(this.usageTracker);
    this.agentBridge = new ClaudeAgentBridge(this.budgetManager, this.usageTracker);
    this.sessionManager = new SessionManager();
  }

  static getInstance(): CentralController {
    if (!CentralController.instance) {
      CentralController.instance = new CentralController();
    }
    return CentralController.instance;
  }

  /**
   * 核心调度方法：分类 → 路由 → 执行
   */
  async handleUserMessage(
    userId: string,
    message: string,
    channelContext: {
      channelType: 'feishu' | 'telegram' | 'web';
      chatId: string;
      onStream: (event: any) => void;
    }
  ): Promise<string> {
    const session = await this.sessionManager.getOrCreate(userId, channelContext.chatId);

    // ======== Step 1: 前置分类 ========
    const classification = await this.classifier.classify(message, {
      hasRecentToolUse: session.hasRecentToolUse(),
      conversationLength: session.getMessageCount(),
      userId,
    });

    this.logger.info(
      `[${userId}] classify: ${classification.complexity} ` +
      `(by ${classification.classifiedBy}, confidence: ${classification.confidence}, ` +
      `cost: $${classification.costUsd.toFixed(4)})`
    );

    // ======== Step 2: 路由执行 ========
    let response: string;

    if (classification.complexity === 'complex') {
      // ---- 复杂任务 → Claude Agent SDK ----
      response = await this.handleComplexTask(userId, message, session, channelContext);
    } else {
      // ---- 简单任务 → 廉价模型 ----
      response = await this.handleSimpleTask(userId, message, session, channelContext);
    }

    // ======== Step 3: 更新会话 ========
    session.addMessage({ role: 'user', content: message });
    session.addMessage({ role: 'assistant', content: response });
    await this.sessionManager.save(session);

    return response;
  }

  /**
   * 复杂任务处理：Claude Agent SDK
   */
  private async handleComplexTask(
    userId: string,
    message: string,
    session: any,
    channelContext: any
  ): Promise<string> {
    this.logger.info(`[${userId}] → Agent SDK (complex task)`);

    const result = await this.agentBridge.execute({
      userId,
      prompt: message,
      conversationHistory: session.getRecentMessages(10),
      workingDirectory: session.getWorkspacePath(),
      model: 'sonnet',
      maxTurns: 30,
      onStream: channelContext.onStream,
    });

    // 标记会话使用了工具（影响后续分类）
    if (result.toolsUsed.length > 0) {
      session.markToolUsed();
    }

    this.logger.info(
      `[${userId}] Agent SDK completed: ${result.turns} turns, ` +
      `${result.toolsUsed.length} tools, $${result.usage.costUsd.toFixed(4)}`
    );

    return result.content;
  }

  /**
   * 简单任务处理：廉价模型直连
   */
  private async handleSimpleTask(
    userId: string,
    message: string,
    session: any,
    channelContext: any
  ): Promise<string> {
    const model = this.lightLLM.getDefaultModel();
    this.logger.info(`[${userId}] → ${model} (simple task)`);

    // 构建上下文（简单任务不需要太长的历史）
    const messages = [
      {
        role: 'system',
        content: `你是 YourBot，一个友好的 AI 助手。当前时间: ${new Date().toISOString()}。
简洁、准确地回答用户问题。如果问题需要执行代码、操作文件或使用工具，请告诉用户你正在切换到高级模式。`,
      },
      ...session.getRecentMessages(5),
      { role: 'user', content: message },
    ];

    // 流式输出
    let fullContent = '';
    for await (const chunk of this.lightLLM.stream({
      model,
      messages,
      maxTokens: 2048,
    })) {
      if (chunk.type === 'text') {
        channelContext.onStream({ type: 'text', data: chunk.data });
        fullContent += chunk.data;
      }
    }

    // 记录用量
    const inputTokens = messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length * 0.5), 0
    );
    const outputTokens = Math.ceil(fullContent.length * 0.5);
    await this.usageTracker.record(userId, {
      provider: model.startsWith('gpt') ? 'openai' : model.startsWith('qwen') ? 'qwen' : 'deepseek',
      model,
      inputTokens,
      outputTokens,
      cacheHitTokens: 0,
      cacheWriteTokens: 0,
      costUsd: this.estimateCheapCost(model, inputTokens, outputTokens),
      conversationId: session.id,
      taskType: 'simple',
      fallbackUsed: false,
    });

    return fullContent;
  }

  /**
   * 简单任务中检测到需要 Agent 能力时，自动升级
   */
  private async handleAutoUpgrade(
    userId: string,
    message: string,
    session: any,
    channelContext: any
  ): Promise<string> {
    channelContext.onStream({
      type: 'text',
      data: '🔄 检测到该任务需要执行操作，正在切换到高级模式...\n\n',
    });
    return this.handleComplexTask(userId, message, session, channelContext);
  }

  private estimateCheapCost(model: string, input: number, output: number): number {
    const prices: Record<string, { input: number; output: number }> = {
      'deepseek-chat': { input: 0.27, output: 1.1 },
      'qwen-turbo': { input: 0.3, output: 0.6 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
    };
    const p = prices[model] || { input: 0.3, output: 1.0 };
    return (input / 1_000_000) * p.input + (output / 1_000_000) * p.output;
  }
}
```

#### 调度流程图
```plaintext
用户: "帮我重构 auth.ts 的登录逻辑"
  │
  ▼
CentralController.handleUserMessage()
  │
  ├── Step 1: TaskClassifier.classify()
  │   ├── 规则预筛: 匹配「帮我重构」→ complex ✓
  │   └── 跳过 LLM 分类（规则已命中）
  │
  ├── Step 2: handleComplexTask()
  │   ├── BudgetManager.checkBudget() → allowed
  │   ├── ClaudeAgentBridge.execute()
  │   │   ├── Agent SDK query(prompt, options)
  │   │   │   ├── Claude 读取 auth.ts (Read 工具)
  │   │   │   ├── Claude 分析代码结构
  │   │   │   ├── Claude 编辑 auth.ts (Edit 工具)
  │   │   │   ├── Claude 运行测试 (Bash 工具)
  │   │   │   └── Claude 返回重构说明
  │   │   └── 流式事件 → channelContext.onStream → 飞书卡片
  │   └── UsageTracker.record()
  │
  └── Step 3: session.addMessage() + save()
```

```plaintext
用户: "量子计算是什么？"
  │
  ▼
CentralController.handleUserMessage()
  │
  ├── Step 1: TaskClassifier.classify()
  │   ├── 规则预筛: 短消息+问号+无动作词 → simple ✓
  │   └── 跳过 LLM 分类
  │
  ├── Step 2: handleSimpleTask()
  │   ├── LightLLMClient.stream('deepseek-chat', messages)
  │   │   └── DeepSeek-V3 流式回复 → 飞书卡片
  │   └── UsageTracker.record() → $0.0008
  │
  └── Step 3: session.addMessage() + save()
```

### 4.1.3 前置任务复杂度分类器
#### 4.1.3.1 两层分类设计
分类器采用 **规则预筛 + LLM 兖底** 的两层设计，最大化效率：
```typescript
// src/kernel/task-classifier.ts
import { LightLLMClient } from './light-llm-client.js';
import { Logger } from '../utils/logger.js';

export type TaskComplexity = 'simple' | 'complex';

export interface ClassifyResult {
  complexity: TaskComplexity;
  reason: string;
  confidence: number;   // 0-1
  classifiedBy: 'rule' | 'llm';
  costUsd: number;       // 分类本身的成本
}

export class TaskClassifier {
  private llmClient: LightLLMClient;
  private logger = new Logger('TaskClassifier');

  // 统计数据：用于优化分类器准确率
  private stats = {
    total: 0,
    ruleClassified: 0,
    llmClassified: 0,
    simpleCount: 0,
    complexCount: 0,
  };

  constructor(llmClient: LightLLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * 两层分类：规则预筛 → LLM 兖底
   */
  async classify(message: string, context?: {
    hasRecentToolUse?: boolean;    // 最近对话是否用过工具
    conversationLength?: number;   // 对话轮次
    userId?: string;
  }): Promise<ClassifyResult> {
    this.stats.total++;

    // 第一层：规则预筛（零成本，~0.1ms）
    const ruleResult = this.ruleClassify(message, context);
    if (ruleResult) {
      this.stats.ruleClassified++;
      if (ruleResult.complexity === 'simple') this.stats.simpleCount++;
      else this.stats.complexCount++;
      return ruleResult;
    }

    // 第二层：LLM 分类（~$0.0003，~200ms）
    const llmResult = await this.llmClassify(message, context);
    this.stats.llmClassified++;
    if (llmResult.complexity === 'simple') this.stats.simpleCount++;
    else this.stats.complexCount++;
    return llmResult;
  }

  /**
   * 第一层：正则规则秒判（零成本）
   * 约 40% 的请求在此层直接分流
   */
  private ruleClassify(
    message: string,
    context?: { hasRecentToolUse?: boolean; conversationLength?: number }
  ): ClassifyResult | null {
    const msg = message.trim();

    // ===== 明确的 Complex 模式 =====

    // 斜杠命令 → 一定是复杂任务
    if (msg.startsWith('/')) {
      return {
        complexity: 'complex',
        reason: '斜杠命令，需要 Agent 执行',
        confidence: 0.99,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // 包含明确的执行/操作意图
    const complexPatterns = [
      /帮我(写|创建|修改|删除|运行|执行|部署|发布|重构)/,
      /(写|创建|生成|编写).*?(代码|函数|脚本|程序|文件|项目)/,
      /(分析|检查|扫描|审查).*?(文件|代码|目录|项目|仓库)/,
      /(定时|自动化|工作流|批量|循环|遍历)/,
      /(安装|配置|搭建|初始化).*?(环境|依赖|服务|数据库)/,
      /(读取?|打开|下载|上传|备份).*?文件/,
      /git\s+(commit|push|pull|merge|rebase|checkout)/,
      /npm\s+(install|run|build|test)/,
      /docker|kubernetes|k8s|kubectl/,
      /(debug|调试|排查|修复).*?(bug|错误|问题|异常)/,
    ];

    for (const pattern of complexPatterns) {
      if (pattern.test(msg)) {
        return {
          complexity: 'complex',
          reason: `匹配复杂任务模式: ${pattern.source.slice(0, 30)}`,
          confidence: 0.95,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      }
    }

    // 上下文中最近用过工具，继续对话很可能仍需工具
    if (context?.hasRecentToolUse && (context?.conversationLength ?? 0) > 0) {
      return {
        complexity: 'complex',
        reason: '会话中有近期工具使用记录，继续任务',
        confidence: 0.85,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // ===== 明确的 Simple 模式 =====

    // 超短消息 + 无动作意图 = 闲聊
    if (msg.length < 30 && !/[帮请让把给]/.test(msg)) {
      return {
        complexity: 'simple',
        reason: '超短消息，无执行意图',
        confidence: 0.90,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // 纯提问模式（以问号结尾，且不含操作动词）
    const isQuestion = /[？?]$/.test(msg);
    const hasActionVerb = /[帮请让把给写创建修改删除运行执行]/.test(msg);
    if (isQuestion && !hasActionVerb && msg.length < 200) {
      return {
        complexity: 'simple',
        reason: '纯提问，无需工具执行',
        confidence: 0.88,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // 翻译请求
    if (/^(翻译|translate|请翻译)[：:]?\s*/i.test(msg)) {
      return {
        complexity: 'simple',
        reason: '翻译任务，不需要 Agent',
        confidence: 0.95,
        classifiedBy: 'rule',
        costUsd: 0,
      };
    }

    // 无法确定 → 交给 LLM
    return null;
  }

  /**
   * 第二层：LLM 分类器（处理模糊地带）
   * 使用 DeepSeek-V3，~200 token，~$0.0003
   */
  private async llmClassify(
    message: string,
    context?: { hasRecentToolUse?: boolean; conversationLength?: number }
  ): Promise<ClassifyResult> {
    const prompt = `你是一个任务复杂度分类器。判断以下用户消息是“simple”还是“complex”。

规则：
- simple: 纯问答、闲聊、翻译、摘要、简单计算、知识查询、意见咨询、创意写作
- complex: 需要操作文件、执行代码、使用工具、多步自动化、系统管理、数据分析（涉及具体文件）

只回复 JSON，不要其他内容：
{"complexity": "simple" 或 "complex", "reason": "简短理由"}

<equation>{context?.hasRecentToolUse ? '注意：当前会话中最近使用过工具。\n' : ''}用户消息：</equation>{message.slice(0, 500)}`;

    try {
      const response = await this.llmClient.complete({
        model: 'deepseek-chat',  // DeepSeek-V3, 最廉价
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 100,
        temperature: 0,
      });

      const parsed = JSON.parse(response.content);
      return {
        complexity: parsed.complexity === 'complex' ? 'complex' : 'simple',
        reason: parsed.reason || 'LLM 分类',
        confidence: 0.82,
        classifiedBy: 'llm',
        costUsd: response.usage?.estimatedCostUsd || 0.0003,
      };
    } catch (error) {
      // LLM 分类失败时默认走 complex（宁可多花钱也不要漏掉需要工具的请求）
      this.logger.warn('LLM classify failed, defaulting to complex:', error);
      return {
        complexity: 'complex',
        reason: 'LLM 分类失败，保守默认为复杂任务',
        confidence: 0.5,
        classifiedBy: 'llm',
        costUsd: 0,
      };
    }
  }

  /**
   * 获取分类器统计数据
   */
  getStats() {
    return {
      ...this.stats,
      ruleClassifyRate: this.stats.total > 0
        ? (this.stats.ruleClassified / this.stats.total * 100).toFixed(1) + '%'
        : '0%',
      simpleRate: this.stats.total > 0
        ? (this.stats.simpleCount / this.stats.total * 100).toFixed(1) + '%'
        : '0%',
    };
  }
}


```

#### 4.1.3.2 分类器决策矩阵


| 用户消息示例 | 分类层 | 结果 | 理由 |
| --- | --- | --- | --- |
| “你好” | 规则 | simple | 超短消息，无执行意图 |
| “/deploy staging” | 规则 | complex | 斜杠命令 |
| “帮我写一个排序算法” | 规则 | complex | 匹配「写…代码」模式 |
| “什么是快速排序？” | 规则 | simple | 纯提问，无操作动词 |
| “翻译：Hello World” | 规则 | simple | 翻译请求 |
| “帮我分析一下这个项目的依赖” | 规则 | complex | 匹配「分析…项目」模式 |
| “总结一下量子计算的原理” | LLM | simple | 知识摘要，不需要工具 |
| “把昨天的会议纪要整理成文档” | LLM | complex | 需要文件操作 |
| “对比一下 React 和 Vue 的优缺点” | LLM | simple | 知识对比，无需工具 |
| “检查 package.json 有什么问题” | LLM | complex | 需要读取具体文件 |


#### 4.1.3.3 分类准确率保障
当 LLM 分类失败或超时时，系统**保守默认为 complex**——宁可多花钱调 Agent SDK，也不要在需要工具的场景下返回低质量的纯文本回答。这个策略确保用户体验不受分类器质量影响。
### 4.1.4 ClaudeAgentBridge — Agent SDK 集成层
#### 4.1.4.1 核心设计
ClaudeAgentBridge 是 YourBot 与 Claude Agent SDK 的唯一接口层。它将 Agent SDK 的 `query()` 函数包装为 YourBot 的内部调用协议，负责注入 SKILL.md、MCP Server、记忆上下文，并将流式事件转发到各通道。
```typescript
// src/kernel/agents/claude-agent-bridge.ts
import { query, ClaudeAgentOptions, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BudgetManager } from '../../budget/budget-manager.js';
import { UsageTracker } from '../../budget/usage-tracker.js';
import { Logger } from '../../utils/logger.js';

export interface AgentBridgeParams {
  userId: string;
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  workingDirectory: string;
  model?: 'opus' | 'sonnet' | 'haiku';
  maxTurns?: number;
  onStream?: (event: StreamEvent) => void;
}

export interface StreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'usage' | 'error';
  data: any;
}

export class ClaudeAgentBridge {
  private budgetManager: BudgetManager;
  private usageTracker: UsageTracker;
  private logger = new Logger('ClaudeAgentBridge');
  private activeSessions = 0;
  private readonly MAX_CONCURRENT_SESSIONS = 20;

  constructor(budgetManager: BudgetManager, usageTracker: UsageTracker) {
    this.budgetManager = budgetManager;
    this.usageTracker = usageTracker;
  }

  /**
   * 执行 Agent 任务
   * 将 YourBot 的请求转换为 Agent SDK 调用
   */
  async execute(params: AgentBridgeParams): Promise<{
    content: string;
    toolsUsed: string[];
    turns: number;
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
  }> {
    // 1. 并发控制
    if (this.activeSessions >= this.MAX_CONCURRENT_SESSIONS) {
      throw new Error('Agent 并发上限已满，请稍后重试。');
    }
    this.activeSessions++;

    try {
      // 2. 预算预检查
      const budgetCheck = await this.budgetManager.checkBudget(
        params.userId,
        2000,   // Agent 任务预估输入 2K token
        4000,   // 预估输出 4K token
        0.04,   // 预估成本 $0.04
      );

      if (!budgetCheck.allowed) {
        throw new Error(budgetCheck.reason);
      }

      // 根据预算情况调整模型
      let model = params.model || 'sonnet';
      if (budgetCheck.suggestedAction === 'downgrade_model') {
        model = 'haiku';
        this.logger.info(`Budget-driven downgrade to haiku for ${params.userId}`);
      }

      // 3. 构建 YourBot 自定义 MCP Server
      const YourBotMcpServer = this.buildYourBotMcpServer(params.userId);

      // 4. 构建 Agent SDK 选项
      const options: ClaudeAgentOptions = {
        model,
        maxTurns: params.maxTurns || 30,
        cwd: params.workingDirectory,

        // 工具权限
        allowedTools: [
          // Agent SDK 内置工具
          'Read', 'Write', 'Edit', 'Bash', 'Glob',
          // YourBot 自定义 MCP 工具
          'mcp__YourBot__*',
        ],

        // 注入 YourBot 的 MCP Server
        mcpServers: {
          'YourBot': YourBotMcpServer,
        },

        // 启用项目级配置（SKILL.md、CLAUDE.md）
        settingSources: ['project'],

        // 注入额外上下文
        appendSystemPrompt: this.buildSystemContext(params.userId),

        // 内部服务使用，绕过交互式权限确认
        permissionMode: 'bypassPermissions',
      };

      // 5. 执行 Agent SDK query
      let content = '';
      const toolsUsed: string[] = [];
      let turns = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for await (const message of query({
        prompt: params.prompt,
        options,
      })) {
        // 处理 Assistant 消息（流式转发）
        if (message.type === 'assistant') {
          turns++;
          for (const block of message.message.content) {
            if ('text' in block) {
              params.onStream?.({ type: 'text', data: block.text });
              content += block.text;
            }
            if ('name' in block && block.type === 'tool_use') {
              toolsUsed.push(block.name);
              params.onStream?.({
                type: 'tool_call',
                data: { name: block.name, input: block.input },
              });
            }
          }
          // 累计 Token 用量
          if (message.message.usage) {
            totalInputTokens += message.message.usage.input_tokens || 0;
            totalOutputTokens += message.message.usage.output_tokens || 0;
          }
        }

        // 处理最终结果
        if (message.type === 'result' && message.subtype === 'success') {
          content = message.result || content;
        }

        // 处理错误
        if (message.type === 'result' && message.subtype !== 'success') {
          params.onStream?.({
            type: 'error',
            data: { subtype: message.subtype, error: message.error },
          });
        }
      }

      // 6. 记录用量
      const costUsd = this.estimateCost(model, totalInputTokens, totalOutputTokens);
      await this.usageTracker.record(params.userId, {
        provider: 'anthropic',
        model: `claude-${model}`,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
        conversationId: '',
        taskType: 'agent',
        fallbackUsed: false,
      });

      return {
        content,
        toolsUsed: [...new Set(toolsUsed)],
        turns,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd },
      };
    } finally {
      this.activeSessions--;
    }
  }

  /**
   * 构建 YourBot 自定义 MCP Server
   * 将 YourBot 特有能力注入 Agent SDK
   */
  private buildYourBotMcpServer(userId: string) {
    return createSdkMcpServer({
      name: 'YourBot',
      version: '1.0.0',
      tools: [
        // 记忆系统工具
        tool(
          'memory_search',
          '搜索用户的长期记忆',
          { query: z.string().describe('搜索关键词') },
          async (args) => {
            const results = await this.searchMemory(userId, args.query);
            return { content: [{ type: 'text', text: JSON.stringify(results) }] };
          }
        ),
        tool(
          'memory_save',
          '保存重要信息到长期记忆',
          {
            key: z.string().describe('记忆标签'),
            content: z.string().describe('需要记忆的内容'),
          },
          async (args) => {
            await this.saveMemory(userId, args.key, args.content);
            return { content: [{ type: 'text', text: `已保存记忆: ${args.key}` }] };
          }
        ),
        // 飞书集成工具
        tool(
          'feishu_send_message',
          '通过飞书发送消息',
          {
            chatId: z.string().describe('飞书群 ID 或用户 ID'),
            content: z.string().describe('消息内容'),
          },
          async (args) => {
            await this.sendFeishuMessage(args.chatId, args.content);
            return { content: [{ type: 'text', text: '消息已发送' }] };
          }
        ),
        // 定时任务工具
        tool(
          'schedule_task',
          '创建定时任务',
          {
            cron: z.string().describe('Cron 表达式'),
            task: z.string().describe('任务描述'),
          },
          async (args) => {
            const id = await this.createScheduledTask(userId, args.cron, args.task);
            return { content: [{ type: 'text', text: `定时任务已创建: ${id}` }] };
          }
        ),
      ],
    });
  }

  /**
   * 构建注入到 Agent SDK 的系统上下文
   */
  private buildSystemContext(userId: string): string {
    return `你是 YourBot 平台中的一个 AI Agent。
当前用户: ${userId}
当前时间: ${new Date().toISOString()}

你拥有以下额外能力（通过 YourBot MCP Server）：
- memory_search / memory_save: 搜索和保存用户的长期记忆
- feishu_send_message: 通过飞书发送消息
- schedule_task: 创建定时任务

项目目录下的 .claude/skills/ 包含可用的技能定义，请在合适时参考使用。
CLAUDE.md 包含项目级指令和用户偏好，请遵循其中的指示。`;
  }

  private estimateCost(model: string, input: number, output: number): number {
    const prices: Record<string, { input: number; output: number }> = {
      opus:   { input: 15, output: 75 },
      sonnet: { input: 3, output: 15 },
      haiku:  { input: 0.8, output: 4 },
    };
    const price = prices[model] || prices.sonnet;
    return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
  }

  // 以下方法需要连接对应的子系统（记忆、飞书、调度）
  private async searchMemory(userId: string, query: string): Promise<any[]> { /* ... */ return []; }
  private async saveMemory(userId: string, key: string, content: string): Promise<void> { /* ... */ }
  private async sendFeishuMessage(chatId: string, content: string): Promise<void> { /* ... */ }
  private async createScheduledTask(userId: string, cron: string, task: string): Promise<string> { /* ... */ return ''; }
}


```

#### 4.1.4.2 SKILL.md 与 Agent SDK 的天然对接
YourBot 的 SKILL.md（§9）与 Claude Code 的 Skills 机制完全兼容。当 `settingSources: ['project']` 启用时，Agent SDK 自动从用户工作空间的 `.claude/skills/` 目录加载所有技能定义：
```plaintext
用户工作空间 (params.workingDirectory)
├── .claude/
│   ├── CLAUDE.md              # 项目级指令（记忆、偏好）
│   ├── settings.json          # 运行时配置
│   └── skills/                # 技能目录
│       ├── code-review.md     # 代码审查技能
│       ├── deploy-staging.md  # 部署技能
│       ├── data-analysis.md   # 数据分析技能
│       └── meeting-summary.md # 会议纪要技能
├── memory/
│   ├── SOUL.md                # Agent 身份记忆
│   └── USER.md                # 用户偏好记忆
└── workspace/
    └── ...                    # 用户文件


```

**零适配成本**：YourBot 的自我进化系统（§12）新生成的技能直接写入 `.claude/skills/` 目录，下次 Agent SDK 调用时自动生效，不需要任何额外注册步骤。
### 4.1.5 LightLLMClient — 廉价模型直连层
#### 4.1.5.1 设计定位
对于分类器判定为 simple 的请求，不需要启动 Agent SDK 子进程，直接调用廉价模型的 API 即可。LightLLMClient 是一个精简的 LLM 调用层，仅保留 `complete()` 和 `stream()` 两个方法。
```typescript
// src/kernel/agents/light-llm-client.ts
import { KeyManager } from '../../llm/key-manager.js';
import { Logger } from '../../utils/logger.js';

interface LightLLMRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface LightLLMResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

/**
 * 廉价模型的轻量调用层
 * 支持 DeepSeek / Qwen / GPT-4o-mini 等 OpenAI 兼容 API
 */
export class LightLLMClient {
  private configs: Map<string, {
    baseUrl: string;
    keyManager: KeyManager;
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  }> = new Map();
  private logger = new Logger('LightLLMClient');

  constructor() {
    // 从环境变量自动配置廉价模型
    this.autoConfigFromEnv();
  }

  private autoConfigFromEnv(): void {
    // DeepSeek
    if (process.env.YourBot_LLM_DEEPSEEK_API_KEY) {
      this.configs.set('deepseek-chat', {
        baseUrl: process.env.YourBot_LLM_DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
        keyManager: new KeyManager(
          process.env.YourBot_LLM_DEEPSEEK_API_KEY.split(',')
        ),
        inputPricePerMillion: 0.27,
        outputPricePerMillion: 1.1,
      });
    }

    // Qwen
    if (process.env.YourBot_LLM_QWEN_API_KEY) {
      this.configs.set('qwen-turbo', {
        baseUrl: process.env.YourBot_LLM_QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        keyManager: new KeyManager(
          process.env.YourBot_LLM_QWEN_API_KEY.split(',')
        ),
        inputPricePerMillion: 0.3,
        outputPricePerMillion: 0.6,
      });
    }

    // GPT-4o-mini
    if (process.env.YourBot_LLM_OPENAI_API_KEY) {
      this.configs.set('gpt-4o-mini', {
        baseUrl: process.env.YourBot_LLM_OPENAI_BASE_URL || 'https://api.openai.com/v1',
        keyManager: new KeyManager(
          process.env.YourBot_LLM_OPENAI_API_KEY.split(',')
        ),
        inputPricePerMillion: 0.15,
        outputPricePerMillion: 0.6,
      });
    }
  }

  /**
   * 同步完成（用于分类器和简单对话）
   */
  async complete(request: LightLLMRequest): Promise<LightLLMResponse> {
    const config = this.configs.get(request.model);
    if (!config) {
      // 找不到指定模型时，选择第一个可用的
      const firstAvailable = this.configs.entries().next().value;
      if (!firstAvailable) throw new Error('No cheap model configured');
      return this.complete({ ...request, model: firstAvailable[0] });
    }

    const apiKey = config.keyManager.getNextKey();

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      config.keyManager.recordError(apiKey, new Error(`${response.status}: ${error}`));
      throw new Error(`LLM API error (${response.status}): ${error}`);
    }

    const data = await response.json() as any;
    const usage = data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    config.keyManager.recordUsage(apiKey, inputTokens + outputTokens);

    return {
      content: data.choices?.[0]?.message?.content || '',
      model: request.model,
      usage: {
        inputTokens,
        outputTokens,
        estimatedCostUsd:
          (inputTokens / 1_000_000) * config.inputPricePerMillion +
          (outputTokens / 1_000_000) * config.outputPricePerMillion,
      },
    };
  }

  /**
   * 流式完成（用于简单对话的打字机效果）
   */
  async *stream(request: LightLLMRequest): AsyncGenerator<{
    type: 'text' | 'done';
    data: string;
  }> {
    const config = this.configs.get(request.model);
    if (!config) throw new Error(`Model ${request.model} not configured`);

    const apiKey = config.keyManager.getNextKey();

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Stream error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const chunk = JSON.parse(line.slice(6));
            const text = chunk.choices?.[0]?.delta?.content;
            if (text) {
              yield { type: 'text', data: text };
            }
          } catch { /* 忽略解析错误 */ }
        }
        if (line === 'data: [DONE]') {
          yield { type: 'done', data: '' };
        }
      }
    }
  }

  /**
   * 获取默认廉价模型（成本最低的优先）
   */
  getDefaultModel(): string {
    // 优先级：gpt-4o-mini > deepseek-chat > qwen-turbo
    if (this.configs.has('gpt-4o-mini')) return 'gpt-4o-mini';
    if (this.configs.has('deepseek-chat')) return 'deepseek-chat';
    if (this.configs.has('qwen-turbo')) return 'qwen-turbo';
    throw new Error('No cheap model configured');
  }
}


```

#### 4.1.5.2 廉价模型选型策略


| 模型 | 输入成本 | 输出成本 | 适用场景 | 优先级 |
| --- | --- | --- | --- | --- |
| GPT-4o-mini | $0.15/M | $0.6/M | 英文对话、逻辑推理 | 1 |
| DeepSeek-V3 | $0.27/M | $1.1/M | 中文对话、编程问答 | 2 |
| Qwen-Turbo | $0.30/M | $0.6/M | 中文场景、阿里云部署 | 3 |


选型原则：
- **默认使用成本最低的可用模型**
- **中国区部署优先 DeepSeek/Qwen**（延迟更低，无需翻墙）
- **国际部署优先 GPT-4o-mini**（覆盖最广，多语言能力强）
### 4.1.6 运行环境：进程级安全隔离
> **v1.1 架构决策**：不再使用 Docker 容器。Claude CLI 本身以独立子进程运行，天然具备进程级隔离能力。每个 Agent 会话 = 一个独立的 Claude CLI 子进程，由 `Bun.spawn("claude", [...args])` 按需创建。**为什么不再需要 Docker？**在 v1.1 架构中，Agent 的执行单元从「Docker 容器」变为「Claude CLI 子进程」。核心理由如下：
1. **天然隔离**：每个 `Bun.spawn` 创建的子进程拥有独立的 PID、内存空间和文件描述符表，OS 层面即实现进程隔离。
1. **启动速度**：子进程启动耗时 < 100ms，远优于容器冷启动（通常 1-5s）。
1. **运维简化**：无需维护 Docker Daemon、镜像构建流水线和容器编排，部署复杂度大幅降低。
1. **资源效率**：子进程按需创建 / 销毁，无容器常驻开销。**安全隔离层级**


| 隔离层级 | 实现方式 | 说明 |
| --- | --- | --- |
| 进程隔离 | `Bun.spawn` 独立子进程 | 每个 Agent 会话运行在独立 OS 进程中，进程间内存不可互访 |
| 文件系统隔离 | `cwd` 独立工作目录 | 每个子进程的工作目录为 `/data/workspaces/{userId}/{sessionId}/`，互不可见 |
| 环境变量隔离 | 每个子进程独立 `env` | API Key 通过 `Bun.spawn` 的 `env` 参数注入，不落盘、不共享 |
| 权限控制 | Claude CLI 内置机制 | `--permission-mode` / `allowedTools` / `disallowedTools` 精细控制 Agent 能力边界 |
| 资源限制（可选） | OS 级 `ulimit` / `cgroup` | 生产环境可通过 cgroup v2 限制单进程 CPU、内存、文件描述符上限 |


**AgentFactory**
```typescript
// src/kernel/agents/agent-factory.ts
export class AgentFactory {
  constructor(
    private config: AgentConfig,
    private workspaceManager: WorkspaceManager,
  ) {}

  async createAgentBridge(sessionId: string): Promise<ClaudeAgentBridge> {
    const workspace = await this.workspaceManager.ensureWorkspace(sessionId);
    return new ClaudeAgentBridge({
      workingDirectory: workspace.absolutePath,
      apiKey: this.config.agentSDK.apiKey,
      model: this.config.agentSDK.model,
      maxTurns: this.config.agentSDK.maxTurns,
      mcpServers: this.config.mcp.servers,
      permissionMode: this.config.agentSDK.permissionMode ?? 'default',
    });
  }

  createLightLLMClient(): LightLLMClient {
    return new LightLLMClient(this.config.lightLLM);
  }
}
```

## 4.2 Agent 生命周期
在混合推理架构下，Agent 生命周期的状态机需要更新。核心变化在于 `Processing` 状态不再是一个单一状态，而是分裂为分类阶段和两条并行路径。
### 生命周期状态机
```plaintext
                         ┌─────────────────────────────────────────────┐
                         │                                             │
  ┌──────┐    ┌──────────▼──┐    ┌──────────────┐                     │
  │ Idle │───▶│ Classifying  │───▶│ Route: SDK   │──▶ AgentSDK Loop   │
  └──────┘    │              │    └──────────────┘   ┌──────────────┐  │
       ▲      │  (分类器判断  │                       │ Tool Calls   │  │
       │      │   复杂度)     │    ┌──────────────┐   │ Multi-turn   │  │
       │      └──────────────┘───▶│ Route: LLM   │   │ Compaction   │  │
       │                          └──────┬───────┘   └──────┬───────┘  │
       │                                 │                  │          │
       │                                 ▼                  ▼          │
       │                          LightLLM Chat      ┌────────────┐   │
       │                          ┌────────────┐     │ Completing │   │
       │                          │ Single-turn│     └─────┬──────┘   │
       │                          └─────┬──────┘           │          │
       │                                ▼                  ▼          │
       │                          ┌─────────────────────────────┐     │
       └──────────────────────────│       Session Updated       │─────┘
                                  └─────────────────────────────┘


```

### AgentLifecycleManager 实现
```typescript
export enum LifecycleState {
  IDLE = 'idle',
  CLASSIFYING = 'classifying',
  AGENT_SDK_PROCESSING = 'agent-sdk-processing',
  LIGHT_LLM_PROCESSING = 'light-llm-processing',
  COMPLETING = 'completing',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export class AgentLifecycleManager extends EventEmitter {
  private contexts: Map<string, LifecycleContext> = new Map();

  constructor(
    private classifier: TaskClassifier,
    private agentBridge: ClaudeAgentBridge,
    private lightLLMClient: LightLLMClient,
    private sessionStore: SessionStore,
    private config: AgentConfig,
  ) { super(); }

  async startLifecycle(
    sessionId: string,
    requestId: string,
    userMessage: string,
  ): Promise<AsyncIterable<KuaiBotEvent>> {
    const ctx: LifecycleContext = {
      sessionId, requestId,
      state: LifecycleState.IDLE,
      startedAt: Date.now(),
    };
    this.contexts.set(requestId, ctx);

    try {
      this.transitionTo(ctx, LifecycleState.CLASSIFYING);
      const session = await this.sessionStore.getOrCreate(sessionId);
      const classification = await this.classifier.classify(
        userMessage, session.getRecentMessages(10),
      );
      ctx.classificationResult = classification;

      if (classification.channel === 'agent-sdk') {
        ctx.channel = 'agent-sdk';
        this.transitionTo(ctx, LifecycleState.AGENT_SDK_PROCESSING);
        return this.processViaAgentSDK(ctx, session, userMessage);
      } else {
        ctx.channel = 'light-llm';
        this.transitionTo(ctx, LifecycleState.LIGHT_LLM_PROCESSING);
        return this.processViaLightLLM(ctx, session, userMessage);
      }
    } catch (error) {
      this.transitionTo(ctx, LifecycleState.ERROR);
      throw error;
    }
  }

  private async *processViaAgentSDK(ctx: LifecycleContext, session: Session, userMessage: string) {
    const agentSession = await this.agentBridge.getOrCreateSession(ctx.sessionId, session.workspacePath);
    for await (const event of this.agentBridge.sendMessage(agentSession, userMessage)) {
      yield event;
    }
    this.transitionTo(ctx, LifecycleState.COMPLETING);
    await this.sessionStore.syncFromAgentSDK(ctx.sessionId, agentSession);
    this.transitionTo(ctx, LifecycleState.COMPLETED);
    this.recordMetrics(ctx);
  }

  private async *processViaLightLLM(ctx: LifecycleContext, session: Session, userMessage: string) {
    const contextMessages = session.getRecentMessages(this.config.lightLLM.contextWindowSize);
    let fullResponse = '';
    for await (const chunk of this.lightLLMClient.streamChat(userMessage, contextMessages)) {
      fullResponse += chunk;
      yield { type: 'text:delta', content: chunk };
    }
    this.transitionTo(ctx, LifecycleState.COMPLETING);
    await session.appendMessages([
      { role: 'user', content: userMessage },
      { role: 'assistant', content: fullResponse },
    ]);
    this.transitionTo(ctx, LifecycleState.COMPLETED);
    this.recordMetrics(ctx);
  }

  async abortLifecycle(requestId: string): Promise<void> {
    const ctx = this.contexts.get(requestId);
    if (!ctx) return;
    if (ctx.channel === 'agent-sdk') await this.agentBridge.abort(ctx.sessionId);
    this.transitionTo(ctx, LifecycleState.ERROR);
  }

  private transitionTo(ctx: LifecycleContext, newState: LifecycleState): void {
    const oldState = ctx.state;
    ctx.state = newState;
    this.emit('lifecycle:transition', { requestId: ctx.requestId, from: oldState, to: newState });
  }

  private recordMetrics(ctx: LifecycleContext): void {
    this.emit('lifecycle:metrics', {
      requestId: ctx.requestId,
      channel: ctx.channel,
      complexity: ctx.classificationResult?.complexity,
      durationMs: Date.now() - ctx.startedAt,
    });
  }
}


```

## 4.3 Sessioning 内核模块
### 4.3.1 为何提升到内核级
Session 管理在混合推理架构中变得更加关键，因为它需要同时服务两条通道，并在通道之间保持一致的对话状态。以下是 Session 模块的依赖关系：


| 依赖方模块 | 依赖 Session 的原因 |
| --- | --- |
| `ClaudeAgentBridge` | 需要读取历史对话以初始化 Agent SDK 会话；需要将 SDK 产出同步回 Session |
| `LightLLMClient` | 需要读取最近 N 轮对话作为上下文窗口 |
| `TaskClassifier` | 需要对话历史以判断上下文相关的任务复杂度 |
| `SessionScheduler` | 管理并发会话数、会话排队、超时回收 |
| `WorkspaceManager` | Session 与 Workspace 一一绑定，Session 创建时触发 Workspace 初始化 |
| `Billing / Metering` | 按 Session 统计 Agent SDK vs LightLLM 用量 |


### 4.3.2 SessionStore 持久化
SessionStore 的持久化设计与架构选型无关，保持分层存储策略。新增 `syncFromAgentSDK` 方法以支持双通道状态同步：
```typescript
export class SessionStore {
  private redis: Redis;       // 热数据：活跃会话（TTL: 2h）
  private pg: Pool;           // 温数据：近期会话（30天）

  async getOrCreate(sessionId: string): Promise<Session> {
    const cached = await this.redis.get(`session:${sessionId}`);
    if (cached) return Session.deserialize(cached);

    const row = await this.pg.query('SELECT data FROM sessions WHERE id = $1', [sessionId]);
    if (row.rows.length > 0) {
      const session = Session.deserialize(row.rows[0].data);
      await this.redis.setex(`session:${sessionId}`, 7200, row.rows[0].data);
      return session;
    }

    const newSession = Session.create(sessionId);
    await this.persist(newSession);
    return newSession;
  }

  async syncFromAgentSDK(sessionId: string, agentSession: AgentSDKSession): Promise<void> {
    const session = await this.getOrCreate(sessionId);
    const newMessages = agentSession.getMessagesSince(session.lastSyncTimestamp);
    for (const msg of newMessages) {
      session.appendMessage({
        role: msg.role, content: msg.content,
        toolUse: msg.tool_use, timestamp: msg.timestamp, source: 'agent-sdk',
      });
    }
    session.lastSyncTimestamp = Date.now();
    await this.persist(session);
  }

  private async persist(session: Session): Promise<void> {
    const serialized = session.serialize();
    await Promise.all([
      this.redis.setex(`session:${session.id}`, 7200, serialized),
      this.pg.query(
        `INSERT INTO sessions (id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [session.id, serialized],
      ),
    ]);
  }
}


```

## 4.4 工作空间管理
工作空间管理在混合架构下新增了对 `.claude/` 目录的初始化逻辑，以支持 Claude Agent SDK 的项目级配置。
```typescript
export interface WorkspacePath {
  absolutePath: string;
  claudeDir: string;        // .claude/ 目录路径
  skillMdPath: string;       // SKILL.md 路径
  settingsPath: string;      // .claude/settings.json 路径
}

export class WorkspaceManager {
  constructor(private baseDir: string) {}

  async ensureWorkspace(sessionId: string): Promise<WorkspacePath> {
    const workspacePath = path.join(this.baseDir, 'workspaces', sessionId);
    const claudeDir = path.join(workspacePath, '.claude');
    const skillMdPath = path.join(workspacePath, 'SKILL.md');
    const settingsPath = path.join(claudeDir, 'settings.json');

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });

    // 初始化 SKILL.md（与 Claude Code Skills 格式完全兼容）
    if (!await this.fileExists(skillMdPath)) {
      await fs.writeFile(skillMdPath, this.generateSkillMd(sessionId));
    }

    // 初始化 .claude/settings.json（Agent SDK 权限与行为配置）
    if (!await this.fileExists(settingsPath)) {
      await fs.writeFile(settingsPath, JSON.stringify(this.generateClaudeSettings(), null, 2));
    }

    return { absolutePath: workspacePath, claudeDir, skillMdPath, settingsPath };
  }

  private generateClaudeSettings(): Record<string, unknown> {
    return {
      permissions: {
        allow: ['Bash(npm install:*)', 'Bash(node:*)', 'Bash(cat:*)', 'Read(*)', 'Write(workspace/*)'],
        deny: ['Bash(rm -rf /)', 'Bash(sudo:*)', 'Bash(curl:*)'],
      },
      model: 'claude-sonnet-4-20250514',
      maxTurns: 20,
    };
  }
}


```

## 4.5 进程级安全配置
> **核心原则**：以最小权限运行每个 Agent 子进程。安全边界由 OS 进程隔离 + Claude CLI 内置权限控制 + 可选 cgroup 三层保障。**ProcessSecurityManager — 子进程安全管理器**
```typescript
// src/kernel/agents/process-security.ts
export interface ProcessSecurityConfig {
  /** 每个 Agent 子进程的最大内存（bytes） */
  maxMemoryPerProcess: number;
  /** 子进程最大执行时间（ms） */
  maxExecutionTime: number;
  /** 允许的最大并发子进程数 */
  maxConcurrentProcesses: number;
  /** 工作目录根路径 */
  workspaceRoot: string;
  /** 是否启用 cgroup 资源限制（需要 Linux） */
  enableCgroup: boolean;
}

export class ProcessSecurityManager {
  private activeProcesses = new Map<string, { proc: any; startTime: number }>();

  constructor(private config: ProcessSecurityConfig) {}

  /** 检查是否可以启动新的子进程 */
  canSpawn(): boolean {
    return this.activeProcesses.size < this.config.maxConcurrentProcesses;
  }

  /** 为子进程构建安全的环境变量（只注入必要项） */
  buildSecureEnv(apiKey: string, sessionId: string): Record<string, string> {
    return {
      ANTHROPIC_API_KEY: apiKey,
      YOURBOT_SESSION_ID: sessionId,
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      HOME: '/tmp',
    };
  }

  /** 注册活跃子进程，启动超时监控 */
  registerProcess(sessionId: string, proc: any): void {
    this.activeProcesses.set(sessionId, { proc, startTime: Date.now() });
    setTimeout(() => {
      if (this.activeProcesses.has(sessionId)) {
        proc.kill('SIGTERM');
        this.activeProcesses.delete(sessionId);
      }
    }, this.config.maxExecutionTime);
  }

  /** 清理已结束的子进程 */
  deregisterProcess(sessionId: string): void {
    this.activeProcesses.delete(sessionId);
  }
}


```

> **安全说明**：`ANTHROPIC_API_KEY` 通过 `Bun.spawn` 的 `env` 参数注入子进程环境变量，不写入文件系统。每个子进程只能访问其 `cwd` 指定的工作目录。生产环境建议配合 `--permission-mode` 严格模式运行。**默认安全配置参考值**


| 维度 | Agent SDK 通道 | LightLLM 通道 |
| --- | --- | --- |
| **适用场景** | 多步骤任务、代码生成/修改、文件操作、需要工具调用的复杂问答 | 简单问答、知识检索、状态查询、闲聊、格式转换 |
| **平均成本** | ~$0.03 / 请求（含工具调用） | ~$0.001 / 请求 |
| **响应延迟** | 2~15s（取决于工具调用轮数） | 0.3~1.5s |
| **工具能力** | 完整 MCP 工具集 + Bash + 文件读写 | 无工具调用（纯文本生成） |
| **上下文管理** | Agent SDK 内置 Compaction，自动管理 | KuaiBot 自管理，滑动窗口策略 |
| **模型** | Claude Sonnet 4 / Claude Opus 4.5 | DeepSeek-V3 / Qwen-72B（可配置） |
| **错误恢复** | SDK 内置重试 + 自修复 | 简单重试，无自修复 |


#### CentralController 路由逻辑
```typescript
// packages/kernel/src/central-controller.ts

import { TaskClassifier, TaskComplexity } from './classifier/task-classifier';
import { ClaudeAgentBridge } from './agent-bridge/claude-agent-bridge';
import { LightLLMClient } from './llm/light-llm-client';
import { SessionStore } from './session/session-store';
import { AgentConfig } from './config/agent-config';

export interface RouteDecision {
  channel: 'agent-sdk' | 'light-llm';
  complexity: TaskComplexity;
  confidence: number;
  reasoning: string;
}

export class CentralController {
  private classifier: TaskClassifier;
  private agentBridge: ClaudeAgentBridge;
  private lightLLM: LightLLMClient;
  private sessionStore: SessionStore;

  constructor(private config: AgentConfig) {
    this.classifier = new TaskClassifier(config.classifier);
    this.agentBridge = new ClaudeAgentBridge(config.agentSDK);
    this.lightLLM = new LightLLMClient(config.lightLLM);
    this.sessionStore = new SessionStore(config.session);
  }

  async handleRequest(
    sessionId: string,
    userMessage: string,
    metadata: RequestMetadata,
  ): Promise<AsyncIterable<KuaiBotEvent>> {
    const session = await this.sessionStore.getOrCreate(sessionId);
    const conversationHistory = session.getRecentMessages(10);
    const decision = await this.routeRequest(userMessage, conversationHistory, metadata);

    if (decision.channel === 'agent-sdk') {
      return this.handleViaAgentSDK(session, userMessage, metadata);
    } else {
      return this.handleViaLightLLM(session, userMessage, metadata);
    }
  }

  private async routeRequest(
    userMessage: string,
    history: ConversationMessage[],
    metadata: RequestMetadata,
  ): Promise<RouteDecision> {
    const classification = await this.classifier.classify({
      message: userMessage,
      history,
      metadata,
    });

    // 强制路由规则（优先于分类器）
    if (metadata.forceChannel) {
      return {
        channel: metadata.forceChannel,
        complexity: classification.complexity,
        confidence: 1.0,
        reasoning: `Force-routed to ${metadata.forceChannel}`,
      };
    }

    // 基于分类结果路由
    if (
      classification.complexity === 'high' ||
      classification.requiresTools ||
      classification.requiresFileAccess
    ) {
      return {
        channel: 'agent-sdk',
        complexity: classification.complexity,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
      };
    }

    return {
      channel: 'light-llm',
      complexity: classification.complexity,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
    };
  }
}


```

### 4.1.3 运行环境：进程级安全隔离
> **v1.1 架构决策**：不再使用 Docker 容器。Claude CLI 本身以独立子进程运行，天然具备进程级隔离能力。每个 Agent 会话 = 一个独立的 Claude CLI 子进程，由 `Bun.spawn("claude", [...args])` 按需创建。**为什么不再需要 Docker？**在 v1.1 架构中，Agent 的执行单元从「Docker 容器」变为「Claude CLI 子进程」。核心理由如下：
1. **天然隔离**：每个 `Bun.spawn` 创建的子进程拥有独立的 PID、内存空间和文件描述符表，OS 层面即实现进程隔离。
1. **启动速度**：子进程启动耗时 < 100ms，远优于容器冷启动（通常 1-5s）。
1. **运维简化**：无需维护 Docker Daemon、镜像构建流水线和容器编排，部署复杂度大幅降低。
1. **资源效率**：子进程按需创建 / 销毁，无容器常驻开销。**安全隔离层级**


| 隔离层级 | 实现方式 | 说明 |
| --- | --- | --- |
| 进程隔离 | `Bun.spawn` 独立子进程 | 每个 Agent 会话运行在独立 OS 进程中，进程间内存不可互访 |
| 文件系统隔离 | `cwd` 独立工作目录 | 每个子进程的工作目录为 `/data/workspaces/{userId}/{sessionId}/`，互不可见 |
| 环境变量隔离 | 每个子进程独立 `env` | API Key 通过 `Bun.spawn` 的 `env` 参数注入，不落盘、不共享 |
| 权限控制 | Claude CLI 内置机制 | `--permission-mode` / `allowedTools` / `disallowedTools` 精细控制 Agent 能力边界 |
| 资源限制（可选） | OS 级 `ulimit` / `cgroup` | 生产环境可通过 cgroup v2 限制单进程 CPU、内存、文件描述符上限 |


**AgentFactory — 无 Docker 依赖**
```typescript
// src/kernel/agents/agent-factory.ts
export class AgentFactory {
  constructor(
    private config: AgentConfig,
    private workspaceManager: WorkspaceManager,
  ) {}

  async createAgentBridge(sessionId: string): Promise<ClaudeAgentBridge> {
    const workspace = await this.workspaceManager.ensureWorkspace(sessionId);
    return new ClaudeAgentBridge({
      workingDirectory: workspace.absolutePath,
      apiKey: this.config.agentSDK.apiKey,
      model: this.config.agentSDK.model,
      maxTurns: this.config.agentSDK.maxTurns,
      mcpServers: this.config.mcp.servers,
      permissionMode: this.config.agentSDK.permissionMode ?? 'default',
    });
  }

  createLightLLMClient(): LightLLMClient {
    return new LightLLMClient(this.config.lightLLM);
  }
}


```

```plaintext


```

## 4.2 Agent 生命周期
在混合推理架构下，Agent 生命周期的状态机需要更新。核心变化在于 `Processing` 状态不再是一个单一状态，而是分裂为分类阶段和两条并行路径。
### 生命周期状态机
```plaintext
                         ┌─────────────────────────────────────────────┐
                         │                                             │
  ┌──────┐    ┌──────────▼──┐    ┌──────────────┐                     │
  │ Idle │───▶│ Classifying  │───▶│ Route: SDK   │──▶ AgentSDK Loop   │
  └──────┘    │              │    └──────────────┘   ┌──────────────┐  │
       ▲      │  (分类器判断  │                       │ Tool Calls   │  │
       │      │   复杂度)     │    ┌──────────────┐   │ Multi-turn   │  │
       │      └──────────────┘───▶│ Route: LLM   │   │ Compaction   │  │
       │                          └──────┬───────┘   └──────┬───────┘  │
       │                                 │                  │          │
       │                                 ▼                  ▼          │
       │                          LightLLM Chat      ┌────────────┐   │
       │                          ┌────────────┐     │ Completing │   │
       │                          │ Single-turn│     └─────┬──────┘   │
       │                          └─────┬──────┘           │          │
       │                                ▼                  ▼          │
       │                          ┌─────────────────────────────┐     │
       └──────────────────────────│       Session Updated       │─────┘
                                  └─────────────────────────────┘


```

### AgentLifecycleManager 实现
```typescript
export enum LifecycleState {
  IDLE = 'idle',
  CLASSIFYING = 'classifying',
  AGENT_SDK_PROCESSING = 'agent-sdk-processing',
  LIGHT_LLM_PROCESSING = 'light-llm-processing',
  COMPLETING = 'completing',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export class AgentLifecycleManager extends EventEmitter {
  private contexts: Map<string, LifecycleContext> = new Map();

  constructor(
    private classifier: TaskClassifier,
    private agentBridge: ClaudeAgentBridge,
    private lightLLMClient: LightLLMClient,
    private sessionStore: SessionStore,
    private config: AgentConfig,
  ) { super(); }

  async startLifecycle(
    sessionId: string,
    requestId: string,
    userMessage: string,
  ): Promise<AsyncIterable<KuaiBotEvent>> {
    const ctx: LifecycleContext = {
      sessionId, requestId,
      state: LifecycleState.IDLE,
      startedAt: Date.now(),
    };
    this.contexts.set(requestId, ctx);

    try {
      this.transitionTo(ctx, LifecycleState.CLASSIFYING);
      const session = await this.sessionStore.getOrCreate(sessionId);
      const classification = await this.classifier.classify(
        userMessage, session.getRecentMessages(10),
      );
      ctx.classificationResult = classification;

      if (classification.channel === 'agent-sdk') {
        ctx.channel = 'agent-sdk';
        this.transitionTo(ctx, LifecycleState.AGENT_SDK_PROCESSING);
        return this.processViaAgentSDK(ctx, session, userMessage);
      } else {
        ctx.channel = 'light-llm';
        this.transitionTo(ctx, LifecycleState.LIGHT_LLM_PROCESSING);
        return this.processViaLightLLM(ctx, session, userMessage);
      }
    } catch (error) {
      this.transitionTo(ctx, LifecycleState.ERROR);
      throw error;
    }
  }

  private async *processViaAgentSDK(ctx: LifecycleContext, session: Session, userMessage: string) {
    const agentSession = await this.agentBridge.getOrCreateSession(ctx.sessionId, session.workspacePath);
    for await (const event of this.agentBridge.sendMessage(agentSession, userMessage)) {
      yield event;
    }
    this.transitionTo(ctx, LifecycleState.COMPLETING);
    await this.sessionStore.syncFromAgentSDK(ctx.sessionId, agentSession);
    this.transitionTo(ctx, LifecycleState.COMPLETED);
    this.recordMetrics(ctx);
  }

  private async *processViaLightLLM(ctx: LifecycleContext, session: Session, userMessage: string) {
    const contextMessages = session.getRecentMessages(this.config.lightLLM.contextWindowSize);
    let fullResponse = '';
    for await (const chunk of this.lightLLMClient.streamChat(userMessage, contextMessages)) {
      fullResponse += chunk;
      yield { type: 'text:delta', content: chunk };
    }
    this.transitionTo(ctx, LifecycleState.COMPLETING);
    await session.appendMessages([
      { role: 'user', content: userMessage },
      { role: 'assistant', content: fullResponse },
    ]);
    this.transitionTo(ctx, LifecycleState.COMPLETED);
    this.recordMetrics(ctx);
  }

  async abortLifecycle(requestId: string): Promise<void> {
    const ctx = this.contexts.get(requestId);
    if (!ctx) return;
    if (ctx.channel === 'agent-sdk') await this.agentBridge.abort(ctx.sessionId);
    this.transitionTo(ctx, LifecycleState.ERROR);
  }

  private transitionTo(ctx: LifecycleContext, newState: LifecycleState): void {
    const oldState = ctx.state;
    ctx.state = newState;
    this.emit('lifecycle:transition', { requestId: ctx.requestId, from: oldState, to: newState });
  }

  private recordMetrics(ctx: LifecycleContext): void {
    this.emit('lifecycle:metrics', {
      requestId: ctx.requestId,
      channel: ctx.channel,
      complexity: ctx.classificationResult?.complexity,
      durationMs: Date.now() - ctx.startedAt,
    });
  }
}


```

## 4.3 Sessioning 内核模块
### 4.3.1 为何提升到内核级
Session 管理在混合推理架构中变得更加关键，因为它需要同时服务两条通道，并在通道之间保持一致的对话状态。以下是 Session 模块的依赖关系：


| 依赖方模块 | 依赖 Session 的原因 |
| --- | --- |
| `ClaudeAgentBridge` | 需要读取历史对话以初始化 Agent SDK 会话；需要将 SDK 产出同步回 Session |
| `LightLLMClient` | 需要读取最近 N 轮对话作为上下文窗口 |
| `TaskClassifier` | 需要对话历史以判断上下文相关的任务复杂度 |
| `SessionScheduler` | 管理并发会话数、会话排队、超时回收 |
| `WorkspaceManager` | Session 与 Workspace 一一绑定，Session 创建时触发 Workspace 初始化 |
| `Billing / Metering` | 按 Session 统计 Agent SDK vs LightLLM 用量 |


### 4.3.2 SessionStore 持久化
SessionStore 的持久化设计与架构选型无关，保持分层存储策略。新增 `syncFromAgentSDK` 方法以支持双通道状态同步：
```typescript
export class SessionStore {
  private redis: Redis;       // 热数据：活跃会话（TTL: 2h）
  private pg: Pool;           // 温数据：近期会话（30天）

  async getOrCreate(sessionId: string): Promise<Session> {
    const cached = await this.redis.get(`session:${sessionId}`);
    if (cached) return Session.deserialize(cached);

    const row = await this.pg.query('SELECT data FROM sessions WHERE id = $1', [sessionId]);
    if (row.rows.length > 0) {
      const session = Session.deserialize(row.rows[0].data);
      await this.redis.setex(`session:${sessionId}`, 7200, row.rows[0].data);
      return session;
    }

    const newSession = Session.create(sessionId);
    await this.persist(newSession);
    return newSession;
  }

  async syncFromAgentSDK(sessionId: string, agentSession: AgentSDKSession): Promise<void> {
    const session = await this.getOrCreate(sessionId);
    const newMessages = agentSession.getMessagesSince(session.lastSyncTimestamp);
    for (const msg of newMessages) {
      session.appendMessage({
        role: msg.role, content: msg.content,
        toolUse: msg.tool_use, timestamp: msg.timestamp, source: 'agent-sdk',
      });
    }
    session.lastSyncTimestamp = Date.now();
    await this.persist(session);
  }

  private async persist(session: Session): Promise<void> {
    const serialized = session.serialize();
    await Promise.all([
      this.redis.setex(`session:${session.id}`, 7200, serialized),
      this.pg.query(
        `INSERT INTO sessions (id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [session.id, serialized],
      ),
    ]);
  }
}


```

## 4.4 工作空间管理
工作空间管理在混合架构下新增了对 `.claude/` 目录的初始化逻辑，以支持 Claude Agent SDK 的项目级配置。
```typescript
export interface WorkspacePath {
  absolutePath: string;
  claudeDir: string;        // .claude/ 目录路径
  skillMdPath: string;       // SKILL.md 路径
  settingsPath: string;      // .claude/settings.json 路径
}

export class WorkspaceManager {
  constructor(private baseDir: string) {}

  async ensureWorkspace(sessionId: string): Promise<WorkspacePath> {
    const workspacePath = path.join(this.baseDir, 'workspaces', sessionId);
    const claudeDir = path.join(workspacePath, '.claude');
    const skillMdPath = path.join(workspacePath, 'SKILL.md');
    const settingsPath = path.join(claudeDir, 'settings.json');

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });

    // 初始化 SKILL.md（与 Claude Code Skills 格式完全兼容）
    if (!await this.fileExists(skillMdPath)) {
      await fs.writeFile(skillMdPath, this.generateSkillMd(sessionId));
    }

    // 初始化 .claude/settings.json（Agent SDK 权限与行为配置）
    if (!await this.fileExists(settingsPath)) {
      await fs.writeFile(settingsPath, JSON.stringify(this.generateClaudeSettings(), null, 2));
    }

    return { absolutePath: workspacePath, claudeDir, skillMdPath, settingsPath };
  }

  private generateClaudeSettings(): Record<string, unknown> {
    return {
      permissions: {
        allow: ['Bash(npm install:*)', 'Bash(node:*)', 'Bash(cat:*)', 'Read(*)', 'Write(workspace/*)'],
        deny: ['Bash(rm -rf /)', 'Bash(sudo:*)', 'Bash(curl:*)'],
      },
      model: 'claude-sonnet-4-20250514',
      maxTurns: 20,
    };
  }
}


```

## 4.5 进程级安全配置
> **核心原则**：以最小权限运行每个 Agent 子进程。安全边界由 OS 进程隔离 + Claude CLI 内置权限控制 + 可选 cgroup 三层保障。**ProcessSecurityManager — 子进程安全管理器**
```typescript
// src/kernel/agents/process-security.ts
export interface ProcessSecurityConfig {
  /** 每个 Agent 子进程的最大内存（bytes） */
  maxMemoryPerProcess: number;
  /** 子进程最大执行时间（ms） */
  maxExecutionTime: number;
  /** 允许的最大并发子进程数 */
  maxConcurrentProcesses: number;
  /** 工作目录根路径 */
  workspaceRoot: string;
  /** 是否启用 cgroup 资源限制（需要 Linux） */
  enableCgroup: boolean;
}

export class ProcessSecurityManager {
  private activeProcesses = new Map<string, { proc: any; startTime: number }>();

  constructor(private config: ProcessSecurityConfig) {}

  /** 检查是否可以启动新的子进程 */
  canSpawn(): boolean {
    return this.activeProcesses.size < this.config.maxConcurrentProcesses;
  }

  /** 为子进程构建安全的环境变量（只注入必要项） */
  buildSecureEnv(apiKey: string, sessionId: string): Record<string, string> {
    return {
      ANTHROPIC_API_KEY: apiKey,
      YOURBOT_SESSION_ID: sessionId,
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      HOME: '/tmp',
    };
  }

  /** 注册活跃子进程，启动超时监控 */
  registerProcess(sessionId: string, proc: any): void {
    this.activeProcesses.set(sessionId, { proc, startTime: Date.now() });
    setTimeout(() => {
      if (this.activeProcesses.has(sessionId)) {
        proc.kill('SIGTERM');
        this.activeProcesses.delete(sessionId);
      }
    }, this.config.maxExecutionTime);
  }

  /** 清理已结束的子进程 */
  deregisterProcess(sessionId: string): void {
    this.activeProcesses.delete(sessionId);
  }
}


```

> **安全说明**：`ANTHROPIC_API_KEY` 通过 `Bun.spawn` 的 `env` 参数注入子进程环境变量，不写入文件系统。每个子进程只能访问其 `cwd` 指定的工作目录。生产环境建议配合 `--permission-mode` 严格模式运行。**默认安全配置参考值**


| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `maxMemoryPerProcess` | 512 MB | 单个 Agent 子进程的内存上限 |
| `maxExecutionTime` | 300,000 ms (5 min) | 单次会话最大执行时间，超时自动 SIGTERM |
| `maxConcurrentProcesses` | 50 | 同时运行的 Agent 子进程数上限 |
| `workspaceRoot` | `/data/workspaces` | 工作目录根路径，子目录按 userId/sessionId 划分 |
| `enableCgroup` | `false` | 生产环境建议开启，需 Linux cgroup v2 支持 |


## 4.6 Agent 配置系统
```typescript
混合推理架构引入了大量新的配置项，包括分类器配置、模型路由配置和特性开关。

```typescript
export interface AgentConfig {
  runMode: RunMode;
  featureFlags: FeatureFlags;
  agentSDK: AgentSDKConfig;
  lightLLM: LightLLMConfig;
  classifier: ClassifierConfig;
  mcp: MCPConfig;
  session: SessionConfig;
  processSecurity: ProcessSecurityConfig;
}

export interface FeatureFlags {
  HYBRID_ARCH_ENABLED: boolean;      // 总开关：关闭则所有请求走 Agent SDK
  CLASSIFIER_LLM_ENABLED: boolean;   // 启用 LLM 分类器
  AGENT_SDK_ENABLED: boolean;        // 启用 Agent SDK 通道
  LIGHT_LLM_ENABLED: boolean;        // 启用 LightLLM 通道
  AUTO_FALLBACK_ENABLED: boolean;    // Agent SDK 超时时降级到 LightLLM
  AB_TEST_ENABLED: boolean;          // A/B 测试模式
  AB_TEST_AGENT_SDK_RATIO: number;   // 0.0 ~ 1.0
}


```

```typescript
// ---- AgentSDKConfig: Claude Agent SDK 通道配置 ----
export interface AgentSDKConfig {
  model: 'opus' | 'sonnet' | 'haiku';           // 默认模型
  maxTurns: number;                              // 单次 query() 最大推理轮次
  apiKey: string;                                // Anthropic API Key（运行时注入）
  permissionMode: 'bypassPermissions';           // 内部服务模式，跳过交互式确认
  settingSources: ('project' | 'user')[];        // SKILL.md / CLAUDE.md 来源
  maxConcurrentSessions: number;                 // 同时活跃的 Agent 会话上限
  timeoutMs: number;                             // 单次 query() 超时（毫秒）
  streamingEnabled: boolean;                     // 是否开启流式事件转发
}

// ---- LightLLMConfig: 廉价模型通道配置 ----
export interface LightLLMConfig {
  defaultModel: 'deepseek-chat' | 'qwen-turbo' | 'gpt-4o-mini';
  contextWindowSize: number;                     // 上下文窗口大小（token）
  maxTokens: number;                             // 单次最大输出 token
  temperature: number;                           // 默认采样温度
  providers: Record<string, {                    // 多供应商配置
    baseUrl: string;
    apiKeyEnvVar: string;                        // 环境变量名
    inputPricePerMillion: number;                // 输入价格 ($/M tokens)
    outputPricePerMillion: number;               // 输出价格 ($/M tokens)
  }>;
}

// ---- ClassifierConfig: 前置复杂度分类器配置 ----
export interface ClassifierConfig {
  llmModel: string;                              // 分类用 LLM（如 'deepseek-chat'）
  llmMaxTokens: number;                          // 分类请求最大 token
  temperature: number;                           // 分类 LLM 温度（推荐 0）
  ruleConfidenceThreshold: number;               // 规则层置信度阈值（>= 则直接采纳）
  llmConfidenceThreshold: number;                // LLM 层置信度阈值
  fallbackComplexity: 'simple' | 'complex';      // 分类失败时的默认值
}

// ---- DEFAULT_AGENT_CONFIG: 全局默认配置常量 ----
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  runMode: 'hybrid',

  featureFlags: {
    HYBRID_ARCH_ENABLED: true,
    CLASSIFIER_LLM_ENABLED: true,
    AGENT_SDK_ENABLED: true,
    LIGHT_LLM_ENABLED: true,
    AUTO_FALLBACK_ENABLED: true,
    AB_TEST_ENABLED: false,
    AB_TEST_AGENT_SDK_RATIO: 0.5,
  },

  agentSDK: {
    model: 'sonnet',
    maxTurns: 30,
    apiKey: '',                                  // 运行时从 env 注入
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    maxConcurrentSessions: 20,
    timeoutMs: 300_000,                          // 5 分钟
    streamingEnabled: true,
  },

  lightLLM: {
    defaultModel: 'deepseek-chat',
    contextWindowSize: 16_384,
    maxTokens: 4_096,
    temperature: 0.7,
    providers: {
      'deepseek-chat': {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnvVar: 'YourBot_LLM_DEEPSEEK_API_KEY',
        inputPricePerMillion: 0.27,
        outputPricePerMillion: 1.1,
      },
      'qwen-turbo': {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKeyEnvVar: 'YourBot_LLM_QWEN_API_KEY',
        inputPricePerMillion: 0.3,
        outputPricePerMillion: 0.6,
      },
      'gpt-4o-mini': {
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnvVar: 'YourBot_LLM_OPENAI_API_KEY',
        inputPricePerMillion: 0.15,
        outputPricePerMillion: 0.6,
      },
    },
  },

  classifier: {
    llmModel: 'deepseek-chat',
    llmMaxTokens: 100,
    temperature: 0,
    ruleConfidenceThreshold: 0.85,
    llmConfidenceThreshold: 0.75,
    fallbackComplexity: 'complex',               // 拿不准时走 Agent SDK 更安全
  },

  mcp: { /* 见 §6 MCP 工具系统配置 */ } as MCPConfig,
  session: { /* 见 §8 记忆系统配置 */ } as SessionConfig,
  processSecurity: { /* 见 §4.5 进程级安全配置 */ } as ProcessSecurityConfig,
};

```

## 4.7 上下文管理
混合架构下，上下文管理不再由 YourBot 自建 `ContextWindowManager` 统一处理，而是根据通道特性采用不同策略：
- **Agent SDK 通道（复杂任务）**：上下文由 Agent SDK 内置的 **Compaction** 机制自动管理。当对话超过模型窗口时，SDK 自动对早期内容进行语义压缩，无需 YourBot 干预。
- **LightLLM 通道（简单任务）**：采用轻量级滑动窗口，仅保留最近 N 轮对话 + 系统提示，满足简单问答的上下文需求。**旧架构 vs 新架构对比**


| 维度 | 旧架构（自建 ContextWindowManager） | 新架构（混合策略） |
| --- | --- | --- |
| 实现方式 | 自建四级策略（全量保留→早期压缩→激进裁剪→紧急截断） | Agent SDK Compaction + LightLLM 滑动窗口 |
| 维护成本 | 高 — 需自行实现 token 计数、压缩算法、策略切换 | 低 — Agent SDK 自动处理；LightLLM 仅需简单截断 |
| 压缩质量 | 一般 — 自建摘要依赖额外 LLM 调用 | 高 — Agent SDK Compaction 经过大规模验证 |
| 适用场景 | 所有请求统一处理 | 按任务复杂度分通道差异化处理 |
| Token 浪费 | 简单对话也做全量上下文构建 | 简单对话仅 5 轮滑动窗口，复杂任务由 SDK 优化 |
| 跨通道一致性 | 统一但粗粒度 | 各通道独立优化，通过 SessionStore 共享核心记忆 |


```typescript
// src/kernel/context/context-manager.ts
import { SessionStore } from '../sessioning/session-store.js';
import { Logger } from '../../utils/logger.js';

/**
 * 混合架构的上下文管理器
 * 不再自建 Compaction 逻辑，而是为两个通道分别构建合适的上下文
 */
export class ContextManager {
  private sessionStore: SessionStore;
  private logger = new Logger('ContextManager');

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  /**
   * 为 LightLLM 通道构建上下文（简单滑动窗口）
   * 仅保留系统提示 + 最近 N 轮对话，控制 token 在廉价模型窗口内
   */
  async buildLightLLMContext(
    userId: string,
    chatId: string,
    systemPrompt: string,
    maxRounds: number = 5,
    maxTokens: number = 8192
  ): Promise<Array<{ role: string; content: string }>> {
    const session = await this.sessionStore.get(userId, chatId);
    const history = session?.messages ?? [];

    // 从最新往回取，直到达到轮次或 token 上限
    const messages: Array<{ role: string; content: string }> = [];
    let tokenCount = this.estimateTokenCount(systemPrompt);
    let rounds = 0;

    for (let i = history.length - 1; i >= 0 && rounds < maxRounds; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokenCount(msg.content);
      if (tokenCount + msgTokens > maxTokens) break;
      messages.unshift(msg);
      tokenCount += msgTokens;
      if (msg.role === 'user') rounds++;
    }

    return [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
  }

  /**
   * 为 Agent SDK 通道构建初始上下文
   * Agent SDK 的 Compaction 会自动管理后续的上下文膨胀
   * 这里只需提供 conversationHistory 作为 query() 的输入
   */
  async buildAgentSDKInitContext(
    userId: string,
    chatId: string,
    maxRecentMessages: number = 10
  ): Promise<Array<{ role: string; content: string }>> {
    const session = await this.sessionStore.get(userId, chatId);
    const history = session?.messages ?? [];

    // Agent SDK 接受完整历史，Compaction 自动处理压缩
    // 但我们仍限制初始注入量，避免首次 query() 就触发 Compaction
    return history.slice(-maxRecentMessages);
  }

  /**
   * Agent SDK Compaction 事件回调
   * 当 SDK 执行 Compaction 时，同步更新 SessionStore 中的摘要
   */
  async onAgentSDKCompaction(
    userId: string,
    chatId: string,
    compactionSummary: string
  ): Promise<void> {
    this.logger.info(
      `[${userId}] Agent SDK compaction triggered, saving summary`
    );
    await this.sessionStore.updateCompactionSummary(
      userId, chatId, compactionSummary
    );
  }

  /**
   * 粗略估算 token 数（中文约 1.5 char/token，英文约 4 char/token）
   */
  private estimateTokenCount(text: string): number {
    const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 1.5 + otherChars / 4);
  }
}
```

**运维关注点**
1. **Compaction 频率监控** — 通过 Agent SDK 事件监听 `compaction` 事件，记录触发频率。频率过高说明任务轮次过长，需考虑拆分任务或调整 `maxTurns`
1. **LightLLM 上下文命中率** — 监控滑动窗口内的消息是否足够回答用户问题。若频繁出现"失忆"现象，可适当增加 `maxRounds` 或启用 SessionStore 中的 `compactionSummary` 前缀注入
1. **跨通道上下文丢失** — 用户可能在同一会话中交替触发 simple/complex 任务，两个通道的上下文独立构建。通过 `SessionStore` 的统一消息历史确保信息不丢失
1. **Session 存储大小** — 混合架构下每条消息只存一份（在 SessionStore），两个通道各自按需读取。定期清理超过 30 天的非活跃会话
> **架构决策记录**：上下文管理从自建四级策略迁移到混合策略的完整论证，见 §17.7 迁移计划。
