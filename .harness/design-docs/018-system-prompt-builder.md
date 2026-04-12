# DD-018: System Prompt 组装器重构

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-11
- **上游**: [DD-011](011-architecture-upgrade-v2.md)
- **下游**: [DD-014](014-unified-agent-execution.md)（统一执行接口消费 prompt）、[DD-015](015-skill-system-upgrade.md)（skill index 生成）

## ���景

当前 `KnowledgeRouter.buildContext()` 承担了 system prompt 组装的全部职责：加载 AIEOS 配置、检索 memory、fragment 分类、冲突解决、token 预算分配、最终组装。

问题：

1. **每轮重建整个 prompt**：没有区分冻结区和易变区，prefix cache 无法利用
2. **Fragment 粒度过细**：逐行分类 SOUL.md/USER.md，增加复杂度��收益不大
3. **Token 预算过小**：`maxContextTokens=4000`，是按 LightLLM 的能力设计的，不适用 Claude Code 200K window
4. **Skill 全量注入**：没有 progressive disclosure
5. **KnowledgeRouter 职能过多**：检索 + 组装 + 冲突解决 + 预算管理混在一个模块

参考系：
- Claude Code 源码：静态前缀 + 动态尾部、三级缓存、MCP delta 注入、`systemPromptSection` vs `DANGEROUS_uncachedSystemPromptSection`
- Hermes：两层分区（内核 vs 工作层）、tool-surface aware、progressive disclosure
- Agentara：CLAUDE.md OVERRIDE 语义、`<system-reminder>` 包裹

## 目标

1. 实现三级缓存架构（Global / Session / Per-Turn）
2. 冻结区 session 内不重建，最大化 prefix cache
3. 易变内容（memory 检索、task guidance）注入到 user message，不影响 system prompt
4. Harness 总占用 ≤ 4% context window
5. 替换 KnowledgeRouter 为职责清晰的模块组合

## 非目标

- 不控制 Claude Code 内部的 context management（它有自己的 6 层 engine）
- 不实现 Claude Code 的 cache editing API（我们走 CLI，无法直接控制 API 缓存）
- 不做 A/B 测试框架

## 方案

### 1. 模块���分

```
KnowledgeRouter（当前，全部职责混合）
    │
    ├─→ SystemPromptBuilder     — ��结区构建（session 级一次性）
    ├─→ TurnContextBuilder      — 每轮注入区构建
    ├─→ SkillIndexBuilder       — Skill 索引生成（DD-015）
    ├─→ MemorySnapshotBuilder   — MEMORY.md 冻结快照
    ��─→ TaskGuidanceBuilder     — 任务指引生成（DD-014）

ConflictResolver       — 保留，但只用于冻结区构建
TokenBudgetAllocator   — 重写，新预算方案
MemoryRetrieverV2      — 保留，输出到 TurnContextBuilder 而非 SystemPrompt
```

### 2. SystemPromptBuilder — 冻结区

```typescript
// src/kernel/prompt/system-prompt-builder.ts

interface FrozenSystemPrompt {
  content: string;                   // 完整的 system prompt 文本
  totalTokens: number;
  builtAt: number;
  sections: {
    identity: string;                // L1
    soul: string;                    // L2
    protocol: string;                // L3
    skillIndex: string;              // L4
    memorySnapshot: string;          // L5
    runtimeHints: string;            // L6
  };
}

class SystemPromptBuilder {
  constructor(
    private configLoader: ConfigLoader,
    private skillIndexBuilder: SkillIndexBuilder,
    private memorySnapshotBuilder: MemorySnapshotBuilder,
    private conflictResolver: ConflictResolver,
  ) {}

  /**
   * 构建冻结的 system prompt。session 开始时调用一次。
   * Compaction 发生后重新调用。
   */
  async build(params: {
    userId: string;
    channel: string;
    workspacePath?: string;
    configLoader?: UserConfigLoader;
  }): Promise<FrozenSystemPrompt> {
    // ── L1: Identity ──
    const identity = await this.loadSection(params, 'IDENTITY.md');

    // ── L2: Soul ──
    const soul = await this.loadSection(params, 'SOUL.md');

    // ── L3: Core Protocol ──
    // 精简版 AGENTS.md：只保留行为规范部分，去掉内部实现细节
    const fullAgents = await this.loadSection(params, 'AGENTS.md');
    const protocol = this.extractCoreProtocol(fullAgents);

    // ── 冲突解决（L1-L3 之间） ──
    const resolved = this.conflictResolver.resolve([
      { source: 'identity', content: identity, priority: 10 },
      { source: 'soul', content: soul, priority: 8 },
      { source: 'protocol', content: protocol, priority: 6 },
    ]);

    // ── L4: Skill Index ──
    const skillIndex = await this.skillIndexBuilder.build(
      params.userId, params.channel
    );

    // ── L5: Memory Snapshot ──
    const memorySnapshot = await this.memorySnapshotBuilder.build(
      params.userId
    );

    // ── L6: Runtime Hints ──
    const runtimeHints = this.buildRuntimeHints(params);

    // ── 组装 ──
    const sections = {
      identity: resolved.find(f => f.source === 'identity')?.content || identity,
      soul: resolved.find(f => f.source === 'soul')?.content || soul,
      protocol: resolved.find(f => f.source === 'protocol')?.content || protocol,
      skillIndex,
      memorySnapshot,
      runtimeHints,
    };

    const content = this.assemble(sections);
    const totalTokens = estimateTokens(content);

    // ── 预算检查 ──
    if (totalTokens > SYSTEM_PROMPT_BUDGET) {
      logger.warn('System prompt exceeds budget', {
        totalTokens,
        budget: SYSTEM_PROMPT_BUDGET,
        sections: Object.fromEntries(
          Object.entries(sections).map(([k, v]) => [k, estimateTokens(v)])
        ),
      });
      // 按优先级裁剪：runtimeHints → memorySnapshot → skillIndex → protocol
      return this.trimToBudget(sections);
    }

    return { content, totalTokens, builtAt: Date.now(), sections };
  }

  private assemble(sections: FrozenSystemPrompt['sections']): string {
    const parts: string[] = [];

    // 顺序固定，保证 prefix 稳定性
    if (sections.identity) {
      parts.push(sections.identity);
    }
    if (sections.soul) {
      parts.push(sections.soul);
    }
    if (sections.protocol) {
      parts.push('# 操作规范\n' + sections.protocol);
    }
    if (sections.skillIndex) {
      parts.push(sections.skillIndex);
    }
    if (sections.memorySnapshot) {
      parts.push(sections.memorySnapshot);
    }
    if (sections.runtimeHints) {
      parts.push('# Runtime\n' + sections.runtimeHints);
    }

    return parts.join('\n\n');
  }

  private extractCoreProtocol(fullAgents: string): string {
    // 从完整 AGENTS.md 中提取行为规范部分
    // 去掉内部实现细节（L0/L1/L2 加载策略、OpenViking 协议等）
    // 只保留：memory 交互协议、工具使用规范、会话管理、Skill 维护协议
    // 目标 ≤ 500 tokens
    return extractSections(fullAgents, [
      'Memory 交互协议',
      '工具使用规范',
      '会话管理',
      'Skill 维护协议',
    ]);
  }

  private buildRuntimeHints(params: { channel: string; workspacePath?: string }): string {
    const lines: string[] = [];
    lines.push(`- 时间：${new Date().toISOString()}`);
    lines.push(`- 通道：${params.channel}`);
    if (params.workspacePath) {
      lines.push(`- 工作目录：${params.workspacePath}`);
    }

    // 通道能力声明
    const channelCaps = CHANNEL_CAPABILITIES[params.channel];
    if (channelCaps) {
      lines.push(`- 通道能力：${channelCaps.join(', ')}`);
    }

    return lines.join('\n');
  }
}

// 预算常量
const SYSTEM_PROMPT_BUDGET = 3000;  // tokens
const CHANNEL_CAPABILITIES: Record<string, string[]> = {
  feishu: ['流式卡片更新', '文件上传下载', '群聊创建'],
  telegram: ['消息编辑(2s限流)', '文件发送'],
  web: ['WebSocket实时推送', '无限流式'],
};
```

### 3. PrependContextBuilder — First User Message

```typescript
// src/kernel/prompt/prepend-context-builder.ts

class PrependContextBuilder {
  /**
   * 构建首条 user message 的前置内容。session 开始时调用一次。
   * 带 OVERRIDE 语义，优先级高于 system prompt 中的默认行为。
   */
  build(params: {
    userId: string;
    userConfig: string;       // USER.md ���整内容
    agentsConfig: string;     // AGENTS.md 完整内容
  }): string {
    return `<system-reminder>
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

# claudeMd
${params.agentsConfig}

# userProfile
${params.userConfig}

# currentDate
Today's date is ${new Date().toISOString().split('T')[0]}.
</system-reminder>`;
  }
}
```

### 4. TurnContextBuilder — Per-Turn 注入

```typescript
// src/kernel/prompt/turn-context-builder.ts

interface TurnContext {
  content: string;
  totalTokens: number;
}

class TurnContextBuilder {
  constructor(
    private memoryRetriever: MemoryRetrieverV2,
    private taskGuidanceBuilder: TaskGuidanceBuilder,
  ) {}

  /**
   * 每轮调用。构建注入到 user message 前面的上下文。
   */
  async build(params: {
    userId: string;
    currentMessage: string;
    classifyResult: UnifiedClassifyResult;
    sessionState: SessionState;
    recentMessages: ConversationMessage[];
  }): Promise<TurnContext> {
    const parts: string[] = [];

    // ── Memory 检索 ──
    const memories = await this.memoryRetriever.retrieve({
      userId: params.userId,
      query: params.currentMessage,
      recentMessages: params.recentMessages,
      budget: MEMORY_CONTEXT_BUDGET,
    });

    if (memories.length > 0) {
      parts.push('<memory-context>');
      parts.push('## 相关记忆');
      for (const m of memories) {
        parts.push(`- [${formatDate(m.updatedAt)}] ${m.content}`);
      }
      parts.push('</memory-context>');
    }

    // ── Task Guidance ──
    const guidance = this.taskGuidanceBuilder.build(
      params.classifyResult,
      { workspacePath: params.sessionState.workspacePath }
    );
    if (guidance) {
      parts.push('<task-guidance>');
      parts.push(guidance);
      parts.push('</task-guidance>');
    }

    // ���─ MCP Delta ──
    const mcpDelta = this.checkMcpDelta(params.sessionState);
    if (mcpDelta) {
      parts.push(mcpDelta);
    }

    // ── Invoked Skills 恢复 ──
    if (params.sessionState.postCompaction && params.sessionState.invokedSkills.size > 0) {
      parts.push('<invoked-skills>');
      parts.push('以下 skills 在本会话中已被使用。上下文压缩后完整内容已移除。');
      parts.push('如需再次使用，请通过 skill_view 重新加载：');
      for (const skill of params.sessionState.invokedSkills) {
        parts.push(`- ${skill}`);
      }
      parts.push('</invoked-skills>');

      // 重置标记，只注入一次
      params.sessionState.postCompaction = false;
    }

    const content = parts.join('\n');
    return { content, totalTokens: estimateTokens(content) };
  }

  private checkMcpDelta(state: SessionState): string | null {
    const current = new Set(state.activeMcpServers);
    const previous = state.previousMcpServers || new Set();

    const added = [...current].filter(s => !previous.has(s));
    const removed = [...previous].filter(s => !current.has(s));

    if (added.length === 0 && removed.length === 0) return null;

    const lines: string[] = ['<mcp-delta>'];
    for (const s of added) {
      lines.push(`MCP server connected: ${s}`);
    }
    for (const s of removed) {
      lines.push(`MCP server disconnected: ${s}`);
    }
    lines.push('</mcp-delta>');

    state.previousMcpServers = new Set(current);
    return lines.join('\n');
  }
}

const MEMORY_CONTEXT_BUDGET = 2000;  // tokens
```

### 5. MemorySnapshotBuilder

```typescript
// src/kernel/prompt/memory-snapshot-builder.ts

class MemorySnapshotBuilder {
  constructor(
    private ov: OpenVikingClient,
    private sessionStore: SessionStore,
  ) {}

  /**
   * 生成 MEMORY.md 内容。反思 agent 整合后调用，或 session 开始时读取缓存。
   */
  async build(userId: string): Promise<string> {
    // 优先读取已整合的 MEMORY.md
    const cached = await this.readCachedSnapshot(userId);
    if (cached) return cached;

    // 无缓存时动态生成（首次使用或缓存过期）
    return this.generateSnapshot(userId);
  }

  private async readCachedSnapshot(userId: string): Promise<string | null> {
    try {
      const content = await this.ov.read(`viking://user/${userId}/config/MEMORY.md`);
      return content || null;
    } catch {
      return null;
    }
  }

  private async generateSnapshot(userId: string): Promise<string> {
    const parts: string[] = ['# Memory Snapshot'];

    // 从 OpenViking 获取高重要性记忆
    const memories = await this.ov.find({
      query: '*',
      scope: `viking://user/${userId}/memories`,
      limit: 20,
      sort: 'importance:desc',
    });

    // 按 category 分组
    const grouped = groupBy(memories, m => m.category);

    if (grouped.preference?.length) {
      parts.push('\n## 用户偏好');
      for (const m of grouped.preference.slice(0, 5)) {
        parts.push(`- ${m.content}`);
      }
    }

    if (grouped.fact?.length) {
      parts.push('\n## 关键事实');
      for (const m of grouped.fact.slice(0, 5)) {
        parts.push(`- ${m.content}`);
      }
    }

    if (grouped.context?.length) {
      parts.push('\n## 项目上下文');
      for (const m of grouped.context.slice(0, 5)) {
        parts.push(`- ${m.content}`);
      }
    }

    // 近期会话摘要
    const recentSessions = this.sessionStore.getRecentSessions({
      userId, days: 7, limit: 3,
    });
    if (recentSessions.length > 0) {
      parts.push('\n## 近期关注');
      for (const s of recentSessions) {
        if (s.summary) {
          parts.push(`- [${formatDate(s.startedAt)}] ${s.summary}`);
        }
      }
    }

    const content = parts.join('\n');

    // 预算裁剪
    return this.truncateTobudget(content, 800);
  }
}
```

### 6. SessionState 扩展

```typescript
// src/shared/tasking/task.types.ts 扩展

interface SessionState {
  // ... existing fields

  // 冻结 prompt（DD-018）
  frozenSystemPrompt?: FrozenSystemPrompt;
  prependContext?: string;

  // Skill 追踪（DD-015）
  invokedSkills: Set<string>;

  // MCP 追踪（DD-018）
  activeMcpServers: Set<string>;
  previousMcpServers?: Set<string>;

  // Compaction 标记（DD-018）
  postCompaction: boolean;
}
```

### 7. 完整调用流程

```typescript
// src/kernel/central-controller.ts（简化示意）

class CentralController {
  private promptBuilder: SystemPromptBuilder;
  private prependBuilder: PrependContextBuilder;
  private turnContextBuilder: TurnContextBuilder;

  async handleSessionInit(session: Session): Promise<void> {
    // 1. 构建冻结 system prompt（一次性）
    session.frozenSystemPrompt = await this.promptBuilder.build({
      userId: session.userId,
      channel: session.channel,
      workspacePath: session.workspacePath,
      configLoader: session.userConfigLoader,
    });

    // 2. 构建 first user message（一次性）
    const userConfig = await session.userConfigLoader.loadFile('USER.md');
    const agentsConfig = await session.userConfigLoader.loadFile('AGENTS.md');
    session.prependContext = this.prependBuilder.build({
      userId: session.userId,
      userConfig,
      agentsConfig,
    });

    // 3. 初始化追踪状态
    session.invokedSkills = new Set();
    session.activeMcpServers = new Set(this.getActiveMcpServers());
    session.postCompaction = false;
  }

  async executeChatPipeline(task: Task): Promise<TaskResult> {
    const session = task.session;

    // 确保 session 已初始化
    if (!session.frozenSystemPrompt) {
      await this.handleSessionInit(session);
    }

    // 构建当轮注入
    const turnContext = await this.turnContextBuilder.build({
      userId: session.userId,
      currentMessage: task.message.content,
      classifyResult: task.classifyResult!,
      sessionState: session,
      recentMessages: session.messages.slice(-5),
    });

    // 组合 prepend（首轮）+ turn context
    const prependParts: string[] = [];
    if (session.messages.length === 0 && session.prependContext) {
      prependParts.push(session.prependContext);
    }
    if (turnContext.content) {
      prependParts.push(turnContext.content);
    }

    // 执行
    const result = await this.agentBridge.execute({
      systemPrompt: session.frozenSystemPrompt.content,
      prependContext: prependParts.join('\n\n'),
      userMessage: task.message.content,
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      workspacePath: session.workspacePath,
      mcpConfig: this.mcpConfigBuilder.build(
        task.classifyResult!.executionMode,
        task
      ),
      executionMode: task.classifyResult!.executionMode,
      classifyResult: task.classifyResult!,
      streamCallback: this.getStreamCallback(session),
    });

    // 追踪 invoked skills（从 tool_use events 中提取）
    if (result.toolsUsed?.includes('skill_view')) {
      // 从 tool 参数中提取 skill 名称
      // 实际实现需要从 stream events 中解析
    }

    return result;
  }

  async handleCompaction(session: Session): Promise<void> {
    // Compaction 触发时重建���结区
    session.frozenSystemPrompt = await this.promptBuilder.build({
      userId: session.userId,
      channel: session.channel,
      workspacePath: session.workspacePath,
    });

    // 标记 post-compaction，下一轮注入 invoked_skills
    session.postCompaction = true;
  }
}
```

### 8. 与 KnowledgeRouter 的迁移关��

```
KnowledgeRouter 当前职责           →  迁移目标
─────────────────────────────────────────────────────
loadAIEOS()                        →  SystemPromptBuilder.build()
buildSearchQuery()                 →  TurnContextBuilder (内部)
OpenViking 检索                    →  TurnContextBuilder.build()（调用 MemoryRetrieverV2）
Fragment 分类 + 优先级              →  删除（不再逐行分类）
ConflictResolver                   →  保留，SystemPromptBuilder 调用
TokenBudgetAllocator               →  重写，新预算常量
assemblePrompt()                   →  SystemPromptBuilder.assemble()

KnowledgeRouter.buildContext()     →  废弃
```

**迁移策略**：新旧并存一段时间。新的 Builder 就绪后，CentralController 切换到新接口，确认稳定后删除 KnowledgeRouter。

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/prompt/system-prompt-builder.ts` | 新增 |
| `src/kernel/prompt/prepend-context-builder.ts` | 新增 |
| `src/kernel/prompt/turn-context-builder.ts` | 新增 |
| `src/kernel/prompt/memory-snapshot-builder.ts` | 新增 |
| `src/kernel/prompt/index.ts` | 新增 — barrel export |
| `src/kernel/evolution/knowledge-router.ts` | 废弃（迁移完成后删除） |
| `src/kernel/evolution/token-budget-allocator.ts` | 重写 — 新预算常量 |
| `src/kernel/evolution/conflict-resolver.ts` | 保留 — 接口不变 |
| `src/kernel/central-controller.ts` | 重构 — 使用新 Builder |
| `src/shared/tasking/task.types.ts` | 扩展 — SessionState 新字段 |

## 备选方案

### 保留 KnowledgeRouter，只改预算

最小改动：把 `maxContextTokens` 从 4000 调大，其他不变。

问题：
- 仍然每轮重建 system prompt
- 无 prefix cache 优化
- Fragment 逐行分类的复杂度不值得

**决策**：彻底重构。KnowledgeRouter 的设计思路正确（fragment + 冲突 + 预算），但实现粒度不适合新架构。

### System Prompt 全部静态化

把 skill index 和 memory snapshot 也做成静态文件，不动态生成。

问题：
- Skill 安装/卸载后需要手动更新
- Memory 整合后需要手动更新
- 失去动态适应能力

**决策**：Session 级动态生成 + session 内冻结。兼顾动态性和缓存。

## 验收标准

- [ ] SystemPromptBuilder 输出 ≤ 3,000 tokens
- [ ] 冻结 prompt session 内不重建（除 compaction）
- [ ] PrependContext 带 OVERRIDE 语义，首轮注入
- [ ] TurnContext 每轮动态构建，包含 memory/guidance/delta
- [ ] Compaction 后 invoked_skills 自动恢复提示
- [ ] MCP delta 只在变更时注入
- [ ] KnowledgeRouter 成功废弃，无残留调用
- [ ] Harness 总占用 ≤ 4% context window (验证方式：日志输出 token 统计)
- [ ] `bun run check:all` 通过

## 参考

- Claude Code 源码 — 静态前缀 + 动态尾部、`systemPromptSection` vs `DANGEROUS_uncachedSystemPromptSection`
- Claude Code 源码 — MCP instructions delta 注入模式
- Claude Code 源码 — `skill_listing` 1% budget、`invoked_skills` 压缩恢复
- Hermes `agent/prompt_builder.py` — 11 层组装顺序
- Agentara — CLAUDE.md OVERRIDE 语义、`<system-reminder>` 包裹
- [DD-011](011-architecture-upgrade-v2.md) — 三级缓存��构总设计
