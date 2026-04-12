# DD-011: 架构升级 V2 — 从 Chatbot 到 Harness

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-12

## 背景

your-ai 当前是一个**请求-响应式 AI 聊天系统**：用户发消息 → 分类 → Agent 处理 → 回复。所有智能都发生在这条同步链路中。

产品定位要求 your-ai 成为一个**知识驱动的自主 AI 助手平台**，具备信息积累、深度探索、学习引导、碎片消化、自我进化、无限扩展等能力。当前架构有三个根本性缺陷：

1. **只有一个执行模型**：同步请求-响应。缺少异步后台任务和自主行为能力
2. **Agent 路由分叉**：simple → LightLLM，complex → Claude Code，两条完全独立的代码路径，且单一 Agent 供应商无容错
3. **Skill 只是 prompt 片段**：无法独立执行、无依赖声明、无自维护能力

## 核心定位决策

> **your-ai = Claude Code 的 Harness**

- **Claude Code** 是 agent 本体 — 负责执行循环、tool 调用、推理决策
- **your-ai** 是 harness — 负责 context engineering、记忆管理、skill 提供、任务调度、通道接入、自我进化

参考 Harrison Chase（LangChain）的定义：Model 是底层能力，Framework 是抽象层，**Harness 是 batteries-included 的 agent 运行时套件**，内置最佳实践，开箱即用又高度可定制。

## 目标

1. 两层执行架构：Intelligence Gateway（LightLLM 快速预处理）+ Agent Layer（Claude Code/Codex 完整 agency）
2. Agent Layer 统一接口，Claude Code 为主、Codex 为 fallback，消除 simple/complex 路由分叉
3. 支撑三种执行模型：同步会话、异步后台任务、Long-horizon 任务
4. 记忆系统从被动存储升级为主动学习（后台反思、记忆整合）
5. Skill 从 prompt 片段升级为可独立执行、可自维护的能力单元
6. System prompt 组装实现三级缓存优化，harness 层占用 ≤ 4% context window

## 非目标

- 不替换 Claude Code 的 agent 循环（不自建 ReAct/Tool-use 循环）
- 不实现 memory provider 插件化（OpenViking 为主，SQLite 补充）
- 不做离线训练/RL 相关能力（hermes-agent 的 trajectory 和 Atropos 部分不引入）
- 不做多 agent 协作（Claude Code 内部的 subagent/delegation 已足够）

## 前置基础设施（先于并行方向实施）

| 基础设施 | 设计文档 | 被谁依赖 |
|---------|---------|---------|
| Session 历史持久化 | [DD-016](016-session-history-persistence.md) | DD-012（反思数据源）、DD-013（聚合上下文） |
| 异步任务执行器 | [DD-017](017-async-task-executor.md) | DD-012（后台反思）、DD-013（异步/Long-horizon 模式） |
| System Prompt 组装器重构 | [DD-018](018-system-prompt-builder.md) | DD-014（统一执行消费 prompt）、DD-015（skill index） |
| 飞书卡片流式处理升级 | [DD-019](019-feishu-streaming-upgrade.md) | DD-014（流式回调接口） |

```
实施顺序：

Phase 0（前置）:  DD-016 + DD-017 + DD-018 + DD-019  ← 可��行
                          │
Phase 1（并行��:  DD-012 + DD-013 + DD-014 + DD-015  ← 依赖 Phase 0

注：DD-013 包含 Long-horizon Resume 设计（Claude Code --resume 恢复）
```

## 四个并行升级方向

| 方向 | 设计文档 | 核心参考 |
|------|---------|---------|
| 记忆和反思 | [DD-012](012-memory-reflection-upgrade.md) | hermes-agent 双层记忆 + /dream 后台整合 |
| 任务调度细化 | [DD-013](013-task-scheduling-upgrade.md) | 同步/异步/Long-horizon 三模式 + 任务聚合 |
| 统一执行 Agent | [DD-014](014-unified-agent-execution.md) | 两层架构（Gateway + Agent Layer），Claude Code/Codex fallback |
| Skill 升级 | [DD-015](015-skill-system-upgrade.md) | hermes progressive disclosure + readiness + patch-first |

## 横切关注点：System Prompt 组装策略

### 设计原则

1. **稳定层冻结，易变层注入** — system prompt 前半段会话内不变，最大化 prefix cache
2. **只暴露真实存在的能力** — skill 索引只列已就绪的 skill
3. **渐进式披露** — skill 完整内容按需加载，memory 按相关性裁剪

### 三级缓存架构

```
System Prompt（冻结，≤2,800 tokens）
┌─ Global Cacheable ─────────────────────────────┐
│ L1: Agent Identity (IDENTITY.md)         ~200t │
│ L2: Agent Soul (SOUL.md)                 ~800t │
│ L3: Core Protocol (精简行为规范)          ~300t │
└────────────────────────────────────────────────┘
┌─ Session Cacheable ────────────────────────────┐
│ L4: Skill Index (名称+描述+就绪状态)     ~500t │
│ L5: Memory Snapshot (MEMORY.md 冻结)     ~800t │
│ L6: Runtime Hints (通道/时间/workspace)  ~200t │
└────────────────────────────────────────────────┘

First User Message（一次性，≤1,500 tokens，OVERRIDE 语义）
┌────────────────────────────────────────────────┐
│ AGENTS.md 完整内容（<system-reminder> 包裹）    │
│ USER.md 冻结快照                                │
│ 当前日期                                        │
└────────────────────────────────────────────────┘

Per-Turn Injection（每轮，≤3,000 tokens）
┌────────────────────────────────────────────────┐
│ <memory-context>: 检索结果                      │
│ <task-guidance>: 任务类型+执行模式+推荐skill     │
│ [mcp_instructions_delta]: MCP 变更时             │
│ [invoked_skills]: Compaction 后恢复              │
└────────────────────────────────────────────────┘

Tool Results（按需披露）
┌────────────────────────────────────────────────┐
│ skill_view → 完整 SKILL.md + scripts/           │
│ memory_search → 详细 memory 内容                 │
│ session_search → 跨会话历史检索                  │
└────────────────────────────────────────────────┘
```

### Token 预算

```
总 Context Window: 200,000 tokens

Harness 总占用:      ≤ 7,300 tokens   (3.65%)
  System Prompt:      2,800t
  First User Message: 1,500t
  Per-Turn Context:   3,000t

对话历史:            ≤ 50,000 tokens  (25%)
  Claude Code 6 层 context engine 自管理

任务执行空间:        ≥ 142,700 tokens (71.35%)
  Tool 调用、推理、skill 加载、文件读写
```

### 组装流程

```
SessionInit:
├─ 构建 System Prompt（冻结区，session 内不变）
│   ├─ loadAIEOS() → L1-L3
│   ├─ buildSkillIndex() → L4
│   ├─ freezeMemorySnapshot() → L5
│   └─ buildRuntimeHints() → L6
├─ 构建 First User Message（一次性）
│   ├─ AGENTS.md（OVERRIDE 语义）
│   ├─ USER.md 快照
│   └─ 当前日期
└─ 初始化追踪状态
    ├─ invokedSkills: Set<string>
    └─ activeMcpServers: Set<string>

EachTurn:
├─ retrieveMemories() → <memory-context>
├─ buildTaskGuidance() → <task-guidance>
├─ checkMcpDelta() → delta attachment (if changed)
├─ checkPostCompaction() → invoked_skills (if compacted)
└─ 传给 AgentBridge

Compaction:
├─ 后台反思（/dream 模式，见 DD-012）
├─ 更新 MEMORY.md
├─ 重建 Session 缓存层
└─ 下一轮注入 invoked_skills 恢复提示
```

## 影响范围

| 模块 | 变更类型 |
|------|---------|
| `src/kernel/central-controller.ts` | 重构 — 拆分为 dispatcher + 执行引擎 |
| `src/kernel/evolution/knowledge-router.ts` | 重构 → `SystemPromptBuilder` |
| `src/kernel/evolution/token-budget-allocator.ts` | 重构 — 新预算方案 |
| `src/kernel/agents/agent-runtime.ts` | 删除 — 拆分为 Gateway + AgentBridge |
| `src/kernel/agents/light-llm-client.ts` | 重新定位为 Gateway 层引擎 |
| `src/kernel/agents/intelligence-gateway.ts` | 新增 — 快速预处理层 |
| `src/kernel/agents/codex-agent-bridge.ts` | 新增 — Codex fallback 实现 |
| `src/kernel/tasking/task-queue.ts` | 扩展 — 支持三种执行模式 |
| `src/kernel/skills/skill-manager.ts` | 升级 — readiness check + progressive disclosure |
| `src/kernel/memory/` | 新增 — MEMORY.md 管理、后台反思、session 历史 FTS |
| `src/kernel/streaming/` | 扩展 — Long-horizon 流式反馈 |
| `src/shared/tasking/task.types.ts` | 扩展 — 执行模式枚举 |

## 验收标准

- [ ] System prompt 冻结区 ≤ 3,000 tokens
- [ ] Harness 总占用 ≤ 4% context window
- [ ] 两层架构就位：Gateway（LightLLM）+ Agent Layer（Claude Code → Codex fallback）
- [ ] Gateway 正确拦截简单任务 + 安全阀正常工作
- [ ] 需要 agency 的任务走统一 AgentBridge 接口
- [ ] Skill 支持 progressive disclosure（索引 + 按需加载）
- [ ] 后台反思 agent 能在 session 结束后自动触发
- [ ] 任务聚合能正确合并 queue 中的噪声消息
- [ ] `bun run check:all` 全部通过

## 参考

- `docs/hermes-agent/` — Hermes Agent 调研（记忆、反思、skill 系统设计）
- `docs/system-prompt/` — Agentara 和 Hermes 的 system prompt 设计调研
- 飞书文档 `CqGcdY1uyofNAnxbodkcrIdInjf` — 从 Chatbot 到 Long-horizon Agent
- 飞书文档 `H3qVdELWFojYlIx1dBmcqcQMnUd` — Claude Code 源码深度解析
- `memory/project_arch_upgrade_plan.md` — 本次架构讨论的决策记录
