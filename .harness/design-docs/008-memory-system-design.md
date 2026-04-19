# AI 助手记忆系统设计 v3.0 — 五层记忆架构实现文档

> **状态**: 已实现（与代码同步，2026-04-15）
> **前身**: v2.4 设计蓝图（初期规划文档，已归档）
> **对应代码**: `src/kernel/memory/`、`src/kernel/evolution/`、`src/kernel/prompt/`、`src/shared/memory/`

---

## 一、项目概述

### 1.1 设计目标

构建跨会话长期记忆系统，使 AI 助手具备：
- 会话内上下文管理与自动压缩（L1 Working Memory）
- 会话级持久化与全文检索（L2 Session Store / SQLite）
- 持久化语义记忆与渐进加载（L3/L4 OpenViking）
- 身份认同与协议文件（L5 AIEOS）
- 自动记忆进化：反思、关联、冲突消解

### 1.2 核心原则

| 原则 | 说明 |
|------|------|
| **OpenViking 基座** | 复用 OpenViking 的向量存储、语义检索、会话管理、关系图谱，通过 HTTP API 集成 |
| **Bun + TypeScript** | 全链路 TypeScript，Bun 运行时 |
| **AIEOS 协议** | 文件优先的身份管理 — SOUL.md / IDENTITY.md / USER.md / AGENTS.md |
| **单机轻量** | 纯本地部署，SQLite + OpenViking，不引入外部服务 |
| **远程模型服务** | 火山引擎豆包 Embedding/VLM/Rerank，零 GPU 门槛 |
| **Token 预算驱动** | 所有记忆注入遵守 token budget，渐进式加载 |
| **从零构建** | 不依赖第三方 Agent 框架 |

### 1.3 核心技术栈

| 技术 | 选型 | 用途 |
|------|------|------|
| **Runtime** | Bun | 高性能 TypeScript 运行时 |
| **AI 引擎** | Claude API + Agent Bridge | 多轮对话推理，支持 Claude/Codex 双桥 |
| **记忆基座** | OpenViking Server | HTTP API，向量 + 图谱 + VikingFS |
| **会话持久化** | SQLite (bun:sqlite) | SessionStore + FTS5 全文检索 |
| **Embedding** | doubao-embedding-vision (火山引擎) | 多模态 Dense 向量，1024 维 |
| **VLM** | doubao-seed-1-8 (火山引擎) | L0/L1 摘要生成、反思推理 |
| **Reranker** | doubao-rerank (火山引擎) | 检索精排 |
| **身份管理** | AIEOS 协议 | 4 个 Markdown 文件定义身份、规则、用户画像 |
| **进程管理** | PM2 | 管理 openviking-server / yourbot-gateway / yourbot-scheduler |

### 1.4 调研背景

本设计综合参考了以下系统的核心思路：

- **OpenClaw**：文件优先理念、AIEOS 协议文件管理、Pre-Compaction Memory Flush 机制
- **Mem0 / Zep / Letta**：记忆分层、图谱增强、上下文压缩
- **A-Mem（NeurIPS 2025）**：Zettelkasten 原子化记忆、自进化网络、动态链接
- **OpenViking**：文件系统范式、L0/L1/L2 三层上下文、层级递归检索、会话记忆自动提取

---

## 二、系统架构

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    CentralController（编排中枢）                    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Prompt Assembly（系统提示组装）                    │ │
│  │  SystemPromptBuilder → FrozenContextManager                  │ │
│  │  MemorySnapshotBuilder → TurnContextBuilder                  │ │
│  │  PrependContextBuilder                                       │ │
│  └─────────────────────────┬───────────────────────────────────┘ │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │              Memory Layer（五层记忆）                          │ │
│  │                                                              │ │
│  │  L1  WorkingMemory         — 会话内上下文缓冲（RAM）          │ │
│  │  L2  SessionStore          — 会话持久化（SQLite + FTS5）      │ │
│  │      SessionMemoryExtractor — 规则 + LLM 会话摘要提取          │ │
│  │  L3  MemoryRetrieverV2     — 渐进加载（token budget 驱动）     │ │
│  │      OpenVikingClient      — 向量检索 + VikingFS + 关系图谱   │ │
│  │  L4  EntityManager         — 轻量图谱（OpenViking link/relations） │
│  │  L5  ConfigLoader          — AIEOS 协议（SOUL/IDENTITY/USER/AGENTS） │
│  │      UserConfigLoader      — 每用户三级配置回退                │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │              Evolution Layer（自进化引擎）                     │ │
│  │                                                              │ │
│  │  ReflectionTrigger        — 反思触发条件判断                   │ │
│  │  ReflectionPromptBuilder  — 反思 Prompt 构建                  │ │
│  │  EvolutionScheduler       — 后台任务调度（link/reflect/evolve） │ │
│  │  AnalysisRouter           — 分析结果路由（memory vs skill）    │ │
│  │  reflect.ts / link.ts / evolve.ts — 原子进化操作               │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │              Context Management（上下文管理）                   │ │
│  │  ContextManager — Pre-Compaction Flush（token 80% 阈值）      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 五层记忆模型

| 层级 | 名称 | 存储 | 生命周期 | 实现模块 |
|------|------|------|----------|----------|
| **L1** | Working Memory | RAM | 单次会话 | `working-memory.ts` |
| **L2** | Session Memory | SQLite | 跨会话持久 | `session-store.ts` + `session-memory-extractor.ts` |
| **L3** | Persistent Memory | OpenViking | 永久 | `memory-retriever-v2.ts` + `openviking-client.ts` |
| **L4** | Graph Memory | OpenViking link/relations | 永久 | `graph/entity-manager.ts` |
| **L5** | AIEOS Identity | 本地文件 + VikingFS | 永久 | `config-loader.ts` + `user-config-loader.ts` |

### 2.3 记忆分类

```typescript
type MemoryCategory = 'preference' | 'fact' | 'context' | 'instruction' | 'task' | 'insight';
type MemoryImportance = 'low' | 'medium' | 'high' | 'critical';
type MemoryLayer = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
```

核心数据结构：

```typescript
interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  importance: MemoryImportance;
  layer: MemoryLayer;
  userId: string;
  createdAt: Date;
  source: string;
}
```

---

## 三、L1 — Working Memory（会话内上下文）

**文件**: `src/kernel/memory/working-memory.ts`

### 3.1 职责

- 维护当前会话的消息缓冲区
- 自动压缩：token 使用超过阈值时提取式压缩
- 提供 LLM 可用的上下文（summaries + messages）

### 3.2 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxTokens` | 100,000 | 最大 token 预算 |
| `compressThreshold` | 0.8 | 压缩触发比例（80%） |

### 3.3 压缩策略

提取式压缩（extractive）：
1. 从消息中点切分为"旧消息"和"保留消息"
2. 旧消息 → 提取第一条 + 关键动作消息（含关键词：error/fix/implement/deploy/create/update/delete/帮/请/修/改/添加/删除）+ 最后一条
3. 生成 `ContextSummary` 存入 summaries 数组
4. 保留 2 个 summaries + 最近消息

### 3.4 Token 估算

```typescript
estimateTokens(): number  // ~4 chars/token（CJK + English 混合）
```

---

## 四、L2 — Session Store（会话持久化）

### 4.1 SessionStore — SQLite 持久化

**文件**: `src/kernel/memory/session-store.ts`

#### Schema

```sql
-- 会话表
sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT,
  conversation_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,           -- 'timeout' | 'explicit' | 'interrupted'
  message_count INTEGER DEFAULT 0,
  summary TEXT,
  reflection_processed INTEGER DEFAULT 0  -- 反思是否已处理
)

-- 消息表
session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,         -- 'user' | 'assistant'
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  token_estimate INTEGER DEFAULT 0
)

-- FTS5 全文检索
session_messages_fts (content) USING fts5(content, tokenize='unicode61')
```

#### 索引

- `idx_sessions_user_time` — (user_id, started_at DESC)
- `idx_sessions_reflection` — (user_id, reflection_processed, ended_at)

#### 写入优化

批量写入队列，两个刷新条件取先到者：
- 消息数 ≥ 20 条
- 距上次刷新 ≥ 5 秒

#### 关键方法

| 方法 | 说明 |
|------|------|
| `createSession(record)` | 创建会话 |
| `closeSession(id, reason, summary?)` | 关闭会话（刷新队列、更新 message_count） |
| `appendMessage(msg)` | 追加消息（批量队列） |
| `searchMessages(query, userId)` | FTS5 全文检索 + JOIN 会话 |
| `getRecentSessions(userId, limit)` | 按时间倒序 |
| `getUnreflectedSessions(userId, limit)` | reflection_processed=0 且已关闭 |
| `markReflectionProcessed(id)` | 标记反思已处理 |
| `markInterruptedOnStartup()` | 启动时标记异常中断的会话 |

### 4.2 SessionMemoryExtractor — 会话摘要提取

**文件**: `src/kernel/memory/session-memory-extractor.ts`

规则式提取 + 可选 LLM 增强：

| 提取项 | 方法 |
|--------|------|
| **keywords** | TF 词频统计，top 10，过滤停用词 + 短词（< 2 chars） |
| **actionItems** | 正则匹配：帮我、请、需要、TODO、please、create、update |
| **preferences** | 正则匹配：我喜欢、I prefer、不要、don't |
| **summary** | LLM 增强（≥ 5 条消息时触发，可选回调） |

输出 `SessionSummary`：

```typescript
interface SessionSummary {
  sessionId: string;
  userId: string;
  summary: string;
  keywords: string[];
  actionItems: string[];
  preferences: string[];
  messageCount: number;
  startedAt: Date;
  endedAt: Date;
}
```

---

## 五、L3 — 持久化记忆（OpenViking）

### 5.1 OpenVikingClient — HTTP SDK

**文件**: `src/kernel/memory/openviking/openviking-client.ts`

#### 配置

| 参数 | 默认值 |
|------|--------|
| `baseUrl` | `http://localhost:1933` |
| `timeout` | 30,000ms |
| `retries` | 2（指数退避） |
| `apiKey` | 可选 |

#### 核心 API

**VikingFS 文件操作**：

| 方法 | 说明 |
|------|------|
| `read(uri)` / `tryRead(uri)` | 读取（tryRead 不抛异常、不重试） |
| `write(uri, content)` | 写入 |
| `abstract(uri)` | ~50-100 tokens 的摘要（L0 级） |
| `overview(uri)` | ~500-2000 tokens 的概览（L1 级） |
| `ls(uri)` / `tree(uri, depth)` | 目录列表 / 树形结构 |
| `mkdir(uri)` / `rm(uri)` / `mv(from, to)` | 文件管理 |
| `stat(uri)` | 元数据 |

**语义检索**：

| 方法 | 说明 |
|------|------|
| `find(options)` | BM25 语义搜索（memories + resources） |
| `search(options)` | 相似度排序检索 |
| `grep(pattern, scope?)` | 模式匹配 |

**关系图谱**：

| 方法 | 说明 |
|------|------|
| `link(fromUri, uris[], reason)` | 创建关系边 |
| `relations(uri)` | 查询入边 / 出边 |
| `unlink(fromUri, uris[])` | 删除关系 |

**会话管理**（用于记忆提取）：

| 方法 | 说明 |
|------|------|
| `createSession(properties?)` | 创建 OV 会话 |
| `addMessage(sessionId, role, content)` | 追加消息 |
| `commit(sessionId)` | 提取记忆并索引 |

#### URI 体系

```
viking://agent/graph/entities/{slug}/content.md  — 图谱实体
viking://user/memories/{category}/{id}           — 持久化记忆
viking://user/{userId}/config/{filename}         — 用户配置
viking://resources                               — 外部资源
viking://skills                                  — 技能库
```

#### 类型定义

**文件**: `src/kernel/memory/openviking/types.ts`

```typescript
interface FindResult {
  uri: string;
  context_type: string;
  abstract: string;
  score: number;
  match_reason: string;
}

interface MatchedContext {
  uri: string;
  content: string;
  level: 'L0' | 'L1' | 'L2';
  score: number;
}

type OVMemoryCategory = 'facts' | 'preferences' | 'procedures' | 'episodic' | 'semantic' | 'meta';
```

### 5.2 MemoryRetrieverV2 — 渐进加载检索

**文件**: `src/kernel/memory/memory-retriever-v2.ts`

#### 核心思路

在 token budget 内渐进加载记忆，优先高分结果、优先详细内容：

```
查询 → ov.find(memories) ∥ ov.find(resources) → 合并排序 → 渐进加载
```

#### 配置

| 参数 | 默认值 |
|------|--------|
| `tokenBudget` | 4,000 |
| `memoryTopK` | 20 |
| `resourceTopK` | 10 |

#### 加载策略

| 剩余 budget | 加载级别 | Token 消耗 |
|-------------|----------|------------|
| > 2,000 | L1 — `overview()` / `read()` | ~500-2000 |
| > 100 | L0 — `abstract()` | ~50-100 |
| ≤ 100 | 停止加载 | — |

文件 URI → `read()`，目录 URI → `overview()` / `abstract()`。

---

## 六、L4 — 轻量图谱

**文件**: `src/kernel/memory/graph/entity-manager.ts`

### 6.1 设计决策

不引入独立图数据库，直接复用 OpenViking 的 `link/relations` + VikingFS 实现轻量图谱。

### 6.2 实体存储

每个实体以 Markdown 文件存储：

```
viking://agent/graph/entities/{slug}/content.md
```

内容包含 `name`、`description`、`properties`（JSON metadata）。

### 6.3 API

| 方法 | 说明 |
|------|------|
| `upsertEntity(name, description, properties)` | 创建/更新实体 |
| `addRelation(from, to, type)` | 关联两个实体 |
| `linkToMemory(entitySlug, memoryUri, reason)` | 实体 → 记忆关联 |
| `query(entitySlug, depth?)` | 图遍历，默认深度 2 |

### 6.4 查询结果

```typescript
interface GraphQueryResult {
  entity: { name, description, properties };
  relations: Array<{ uri, reason, created_at }>;
  // depth > 1 时递归展开关系链
}
```

---

## 七、L5 — AIEOS 身份协议

### 7.1 ConfigLoader — 全局配置

**文件**: `src/kernel/memory/config-loader.ts`

加载 4 个 AIEOS 协议文件：

| 文件 | 作用 |
|------|------|
| `SOUL.md` | 核心价值、信任边界、安全规则、记忆策略、Lessons Learned |
| `IDENTITY.md` | 名字、版本、角色、沟通风格 |
| `USER.md` | 用户偏好、技术倾向、工作习惯 |
| `AGENTS.md` | 记忆交互协议、工具使用规则、对话管理 |

**加载策略**：本地文件优先，VikingFS 回退。60 秒 TTL 缓存。

**关键方法**：

| 方法 | 说明 |
|------|------|
| `loadAll()` | 并行加载 4 文件 |
| `getLessonsLearned()` | 提取 SOUL.md 的 `## Lessons Learned` 段 |
| `updateUserProfile(content)` | 写本地 + 同步 VikingFS |

### 7.2 UserConfigLoader — 每用户配置

**文件**: `src/kernel/memory/user-config-loader.ts`

三级回退链：

```
user-space/{userId}/memory/{filename}  →  viking://user/{userId}/config/{filename}  →  全局 ConfigLoader
```

本地存在但远端缺失时，自动 best-effort 同步。

### 7.3 共享接口

**文件**: `src/shared/memory/memory.interfaces.ts`

解耦层，允许 `lessons/` 等外围模块引用 kernel 类型：

```typescript
interface IConfigLoader {
  loadAll(): Promise<AIEOSConfig>;
  getLessonsLearned(): Promise<string>;
  updateUserProfile(content: string): Promise<void>;
}

interface IUserConfigLoader {
  loadAll(): Promise<AIEOSConfig>;
  writeConfig(filename: string, content: string): Promise<void>;
  invalidateCache(): void;
}

interface IOpenVikingClient {
  write(uri: string, content: string): Promise<void>;
}
```

---

## 八、Prompt 注入链路

记忆如何进入 LLM 上下文：

```
SystemPromptBuilder (会话级，冻结)
  ├─ IDENTITY.md + SOUL.md + AGENTS.md        — L5 身份
  ├─ MemorySnapshotBuilder                     — L3/L4 记忆快照
  │   └─ 分类展示 (preferences/facts/context)
  │   └─ max 200 行 / 800 tokens
  └─ SkillIndexBuilder                         — 技能索引

PrependContextBuilder (首轮 OVERRIDE)
  └─ 首轮注入特殊指令

TurnContextBuilder (每轮动态注入)
  ├─ <memory-context>    — 检索到的相关记忆 (2000 token budget)
  ├─ <task-guidance>     — 执行指引 (sync/async/long-horizon)
  ├─ <invoked-skills>    — post-compaction 恢复提示
  └─ <mcp-delta>         — MCP server 变更通知
```

### Token 预算

| 区域 | Budget |
|------|--------|
| `SYSTEM_PROMPT_BUDGET` | 3,000 tokens |
| `MEMORY_CONTEXT_BUDGET` | 2,000 tokens |
| Memory Snapshot | 800 tokens / 200 行 |
| Token 估算 | `Math.ceil(length / 4)` |

**关键文件**：
- `src/kernel/prompt/system-prompt-builder.ts`
- `src/kernel/prompt/memory-snapshot-builder.ts`
- `src/kernel/prompt/turn-context-builder.ts`
- `src/kernel/prompt/prepend-context-builder.ts`
- `src/kernel/prompt/prompt-types.ts`

---

## 九、记忆进化引擎

**目录**: `src/kernel/evolution/`

### 9.1 整体流程

```
会话关闭
  ↓
OpenViking commit(sessionId)  →  提取记忆
  ↓
EvolutionScheduler.schedulePostCommit()
  ├─ 对每条新记忆：enqueue link 任务
  └─ 对 facts/preferences/procedures 类别：enqueue reflect 任务
  ↓
后台异步执行（并发上限 2，失败重试 1 次，指数退避）
```

### 9.2 三个原子操作

#### Link（关联发现）

**文件**: `src/kernel/evolution/link.ts`

1. 加载新记忆的 abstract
2. OpenViking `find()` 搜索相似记忆
3. 对 score > 0.75 的结果调用 `ov.link(newUri, [similarUri], "semantic_similarity:0.XX")`

#### Reflect（反思提炼）

**文件**: `src/kernel/evolution/reflect.ts`

1. 按类别查找所有记忆（≥ 5 条才触发）
2. 加载 abstracts
3. Claude 分析："从这些摘要中提取 2-3 条高层洞见"
4. 写入 `viking://user/memories/semantic/{slug}`

#### Evolve（冲突消解）

**文件**: `src/kernel/evolution/evolve.ts`

比较新旧记忆，LLM 判断关系：

| 关系 | 处理 |
|------|------|
| `SUPERSEDE` | 新完全替代旧（取新） |
| `SUPPLEMENT` | 新扩展旧（追加） |
| `CONTRADICT` | 冲突消解（以新为准合并） |
| `DUPLICATE` | 跳过 |

### 9.3 EvolutionScheduler

**文件**: `src/kernel/evolution/evolution-scheduler.ts`

- 非阻塞后台调度器
- 并发上限：2 个任务
- 重试：1 次，指数退避
- API：`schedulePostCommit(uris)` / `scheduleEvolve(newContent, existingUri)`

### 9.4 反思触发

**文件**: `src/kernel/evolution/reflection-trigger.ts`

触发条件（AND）：
- 距上次反思 ≥ 24 小时
- 未反思的已关闭会话 ≥ 5 个

例外：从未反思过 + ≥ 5 个会话 → 直接触发。

### 9.5 反思 Prompt 构建

**文件**: `src/kernel/evolution/reflection-prompt-builder.ts`

四阶段流程：Orient → Gather → Consolidate → Prune

路由规则：

| 提取类型 | 目标 |
|----------|------|
| facts / preferences / constraints / lessons | → Memory Store |
| methods / templates / troubleshooting | → Skill 候选 |
| 过时内容 | → 删除 |
| 冲突 | → 以最新为准更新 |

### 9.6 AnalysisRouter

**文件**: `src/kernel/evolution/analysis-router.ts`

规则式路由（无 LLM）：

```typescript
interface AnalysisItem {
  content: string;
  type: 'fact' | 'preference' | 'constraint' | 'lesson' | 'method' | 'template' | 'troubleshooting';
}

interface RoutedAnalysis {
  memories: AnalysisItem[];       // fact/preference/constraint/lesson
  skillCandidates: AnalysisItem[]; // method/template/troubleshooting
}
```

---

## 十、Pre-Compaction Memory Flush

**文件**: `src/kernel/memory/context-manager.ts`

### 10.1 机制

当 token 使用率超过 80%（基于 128K 上下文窗口）时：

1. 检查 `tokenRatio > threshold`
2. 调用 `ov.commit(sessionId)` 提交会话记忆到 OpenViking
3. 调用 `ov.find()` 检索关键记忆
4. 生成 anchor text（Markdown 列表），用于 compaction 后恢复上下文

### 10.2 输出

Anchor text 示例：

```markdown
- [关键记忆 1](viking://user/memories/facts/xxx)
- [用户偏好](viking://user/memories/preferences/yyy)
```

---

## 十一、数据流全景

### 11.1 消息处理（读路径）

```
用户消息
  ↓
CentralController.handleUserMessage()
  ├─ SystemPromptBuilder.build()           — 冻结系统提示（会话首次）
  │   ├─ ConfigLoader.loadAll()            — L5 AIEOS
  │   └─ MemorySnapshotBuilder.build()     — L3/L4 快照
  ├─ TurnContextBuilder.build()            — 每轮注入
  │   └─ MemoryRetrieverV2.retrieve()      — L3 渐进检索
  │       └─ ov.find() ∥ ov.find()         — 并行搜索
  └─ AgentBridge.execute()                 — LLM 推理
```

### 11.2 会话关闭（写路径）

```
会话关闭
  ↓
SessionStore.closeSession()                 — 刷新队列、更新 message_count
  ↓
ov.commit(sessionId)                        — 提取记忆到 OpenViking
  ↓
EvolutionScheduler.schedulePostCommit()     — 入队 link + reflect
  ↓
ReflectionTrigger.shouldReflect()           — 检查是否需要反思
  ├─ 是 → 加载未反思会话 → 构建 prompt → TaskDispatcher.dispatch('reflection')
  │       → markReflectionProcessed()       — 标记已处理
  └─ 否 → 结束
```

### 11.3 反思执行

```
TaskDispatcher 调度反思任务
  ↓
CentralController.executeChatPipeline()     — type: 'system'
  ↓
REFLECTION_SYSTEM_PROMPT + session summaries
  ↓
Claude 四阶段分析 → AnalysisItem[]
  ↓
AnalysisRouter.routeAnalysis()
  ├─ memories → OpenViking 写入
  └─ skillCandidates → Skill 管道
```

---

## 十二、进程管理

**文件**: `ecosystem.config.cjs`

| 进程 | 入口 | 说明 |
|------|------|------|
| `openviking-server` | OpenViking 守护进程 | 向量库 + 图谱 + VikingFS |
| `yourbot-gateway` | HTTP/WS 网关 (port 3000) | 消息入口，依赖 OpenViking |
| `yourbot-scheduler` | `src/kernel/scheduling/scheduler.ts` | 定时任务，每日 4am UTC 重启 |

---

## 十三、文件索引

```
src/kernel/memory/
├── index.ts                      — barrel export
├── memory-types.ts               — MemoryEntry/Layer/Category 类型
├── working-memory.ts             — L1 会话内上下文缓冲
├── session-store.ts              — L2 SQLite 会话持久化
├── session-memory-extractor.ts   — 会话摘要提取
├── memory-retriever-v2.ts        — L3 渐进加载检索
├── context-manager.ts            — Pre-Compaction Flush
├── config-loader.ts              — L5 全局 AIEOS 加载
├── user-config-loader.ts         — L5 每用户三级回退
├── openviking/
│   ├── openviking-client.ts      — OpenViking HTTP SDK
│   └── types.ts                  — OV 类型定义
└── graph/
    └── entity-manager.ts         — L4 轻量图谱

src/kernel/evolution/
├── reflection-trigger.ts         — 反思触发判断
├── reflection-prompt-builder.ts  — 反思 Prompt 构建
├── analysis-router.ts            — 分析结果路由
├── evolution-scheduler.ts        — 后台进化调度
├── reflect.ts                    — 反思操作
├── link.ts                       — 关联操作
└── evolve.ts                     — 冲突消解操作

src/kernel/prompt/
├── system-prompt-builder.ts      — 冻结系统提示构建
├── memory-snapshot-builder.ts    — 记忆快照（MEMORY.md 段）
├── turn-context-builder.ts       — 每轮动态注入
├── prepend-context-builder.ts    — 首轮 OVERRIDE 注入
└── prompt-types.ts               — Prompt 类型定义

src/shared/memory/
└── memory.interfaces.ts          — 解耦接口（IConfigLoader 等）
```

---

## 十四、设计演进记录

| 版本 | 时间 | 变更 |
|------|------|------|
| v2.4 | 2026-03 | 初始设计蓝图（已归档） |
| v3.0 | 2026-04-15 | 与实现对齐：补充 SessionStore/SQLite、Prompt 注入链路、Evolution 引擎、文件索引 |
