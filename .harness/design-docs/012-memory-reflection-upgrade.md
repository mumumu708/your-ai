# DD-012: 记忆和反思升级

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-11
- **上游**: [DD-011](011-architecture-upgrade-v2.md)

## 背景

当前记忆系统的三个问题：

1. **Memory 和 Skill 混为一谈**：evolution 模块的 `PostResponseAnalyzer` + `ErrorToRulePipeline` 把发现的事实、偏好、方法、流程都往 memory 存，没有区分"知道什么"和"怎么做"
2. **无冻结快照**：`UserConfigLoader` 每轮重新加载 AIEOS 文件，prefix cache 无法命中
3. **反思是同步的规则驱动**：`PostResponseAnalyzer` 在主链路中同步执行，只做简单的模式匹配纠错，无法进行深度回顾

参考系：
- hermes-agent：双层记忆（Foundation + Enhancement）、Memory vs Skill 分工、后台反思 agent
- Claude Code /dream：4 阶段后台记忆整合（Orient → Gather → Consolidate → Prune）

## 目标

1. Memory 存事实/偏好（what），Skill 存方法/流程（how）
2. Session 级别冻结 memory 快照，最大化 prefix cache
3. 后台反思 agent 在 session 结束后异步深度回顾
4. MEMORY.md 索引文件自动生成维护，≤200 行/25KB
5. Session 历史持久化，支持跨会话全文检索

## 非目标

- 不做 memory provider 插件化
- 不替换 OpenViking 存储引擎
- 不做实时记忆更新（冻结快照意味着会话内不更新 system prompt 中的 memory）

## 方案

### 1. Memory vs Skill 分离

#### 分流规则

| 发现类型 | 存储目标 | 示例 |
|---------|---------|------|
| 事实 | Memory（OpenViking） | "用户在字节跳动工作" |
| 偏好 | Memory（OpenViking） | "偏好简洁回复" |
| 环境约束 | Memory（OpenViking） | "项目使用 Bun 运行时" |
| 经验教训 | Memory（OpenViking） | "飞书 API 返回 { data: { ... } } 需要解包" |
| 可复用方法 | Skill（文件系统） | "处理 RSS 时先 fetch 再 score 再 render" |
| 操作模板 | Skill（文件系统） | "部署流程：build → test → push → PR" |
| 问题排查步骤 | Skill（文件系统） | "TypeScript 类型错误排查三步法" |

#### 实现变更

`PostResponseAnalyzer` 的输出从单一的 memory 写入，变为双路输出：

```typescript
interface AnalysisResult {
  memories: MemoryCandidate[];    // → OpenViking memory_store
  skillPatches: SkillPatch[];     // → SkillManager.patch()
  corrections: Correction[];      // → 经验教训（仍存 memory）
}
```

`KnowledgeRouter` 在构建 system prompt 时分别处理：
- memory → 注入 `<memory-context>` 或冻结到 MEMORY.md
- skill → 注入 skill 索引（仅名称+描述）

### 2. 冻结快照机制

#### Session 级别冻结

```
SessionManager.resolveSession()
    │
    ├─ 首次创建 session 时：
    │   ├─ configLoader.loadAll() → 加载 SOUL/IDENTITY/USER/AGENTS
    │   ├─ memoryRetriever.buildSnapshot() → 生成 MEMORY.md 内容
    │   └─ 冻结到 session.frozenContext:
    │       {
    │         soul: string,
    │         identity: string,
    │         user: string,
    │         agents: string,
    │         memorySnapshot: string,  // MEMORY.md 内容
    │         skillIndex: SkillIndexEntry[],
    │         frozenAt: number
    │       }
    │
    └─ 后续每轮：直接读 session.frozenContext，不重新加载
```

#### MEMORY.md 格式

```markdown
# MEMORY.md
<!-- 自动生成，上次整合：2026-04-11T08:00:00+08:00 -->

## 用户画像
- 后端工程师，5年经验，字节跳动
- 偏好简洁直接的回复风格
- 技术讨论用中文

## 项目上下文
- your-ai：个人 AI 助手平台，Bun 运行时
- 五层架构：Gateway → Kernel → Shared → UserSpace → Infra
- 主要通道：飞书、Telegram、Web

## 近期关注
- AI Agent 架构升级（Long-horizon / Harness）
- Hermes-Agent 的记忆和 Skill 系统
- System Prompt 三级缓存设计

## 活跃任务
- 架构升级技术文档编写中

## 关键偏好
- 不要问"要不要跑测试"，改完代码直接跑
- Git worktree 工作流
- 代码和文档在同一个 commit
```

**约束**：≤200 行 / ≤25KB / ≤800 tokens

#### 冻结 vs 每轮检索的关系

| 内容 | 注入位置 | 更新频率 | 用途 |
|------|---------|---------|------|
| MEMORY.md 快照 | System Prompt L5 | 会话级冻结 | 全局背景：用户是谁、项目是什么、近期关注什么 |
| `<memory-context>` | Per-Turn Injection | 每轮检索 | 当轮相关：与当前问题语义相关的具体记忆 |

两者互补，不冲突。

### 3. 后台反思 Agent（/dream 模式）

#### 触发条件

```typescript
interface ReflectionTrigger {
  // 必须同时满足：
  minSessionsSinceLastReflection: 5;    // 自上次反思以来 ≥5 个新会话
  minHoursSinceLastReflection: 24;      // 距上次反思 ≥24 小时
  // 互斥锁：
  lockFile: 'data/.reflect-lock';       // 防止并发执行
}
```

触发时机：
- **被动触发**：session 关闭时检查条件，满足则启动
- **主动触发**：用户命令（类似 /dream）
- **定时触发**：Scheduler 注册的每日整合任务

#### 执行流程（4 阶段）

```
Phase 1: Orient（定向）
├─ 读取当前 MEMORY.md
├─ 列出已有 skill 索引
└─ 确定上次反思时间，计算需要回顾的 session 范围

Phase 2: Gather（收集）
├─ 从 session 历史（SQLite FTS）中检索新信息
│   ├─ 优先级：错误纠正 > 新事实发现 > 偏好表达
│   └─ 不全量读取，用关键词搜索
├─ 从现有 memory 中找过时或矛盾条目
└─ 从 skill 执行记录中找失败或低效案例

Phase 3: Consolidate（整合）
├─ 新事实 → memory_store（如果不存在）
├─ 矛盾事实 → memory 更新（新的替代旧的）
├─ 可复用方法 → Skill 创建或 patch
├─ 过时事实 → memory 删除
└─ 相对日期转绝对日期

Phase 4: Prune（修剪）
├─ 重新生成 MEMORY.md（≤200 行/25KB）
├─ 清除低重要性、长期未访问的 memory
└─ 更新反思元数据（时间戳、session 计数器）
```

#### 执行方式

后台反思作为**独立的 Claude Code session** 运行：

```typescript
// 伪代码
async function runReflection(userId: string) {
  const reflectionPrompt = buildReflectionPrompt(userId);

  await agentBridge.execute({
    systemPrompt: REFLECTION_SYSTEM_PROMPT,  // 精简版，只含反思指引
    userMessage: reflectionPrompt,
    tools: ['memory_store', 'memory_search', 'memory_delete',
            'skill_manage', 'session_search'],
    // 不需要通道相关工具
    // 不需要流式输出
  });
}
```

反思 agent 与前台 agent **共享存储**（OpenViking + Skill 文件系统），但**不共享会话**。

### 4. Session 历史持久化

#### SQLite Schema 扩展

```sql
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- 'user' | 'assistant'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  token_count INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- FTS5 虚拟表，支持跨会话全文检索
CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  content,
  content=session_messages,
  content_rowid=id
);

-- 自动同步触发器
CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  message_count INTEGER DEFAULT 0,
  summary TEXT,                 -- 会话摘要（关闭时生成）
  reflection_processed BOOLEAN DEFAULT FALSE
);
```

#### session_search MCP Tool

```typescript
// 暴露给 Claude Code 的 MCP tool
interface SessionSearchTool {
  name: 'session_search';
  operations: {
    // 关键词搜索
    keyword_search: {
      query: string;
      userId: string;
      limit?: number;          // default 10
    };
    // 近期会话列表
    recent: {
      userId: string;
      days?: number;           // default 7
      limit?: number;          // default 5
    };
  };
  // 返回：session 摘要 + 匹配的消息片段
}
```

### 5. 存储职责分配

| 数据类型 | 存储 | 理由 |
|---------|------|------|
| Memory 内容（事实、偏好、经验） | OpenViking | 语义检索 |
| AIEOS 配置（SOUL/IDENTITY/USER/AGENTS） | 文件系统 | 每次完整加载 |
| MEMORY.md 索引 | 文件系统 + OpenViking 备份 | 快速加载 + 持久化 |
| Session 历史 | SQLite（Drizzle） | 结构化查询 + FTS |
| 反思元数据（上次时间、计数器） | SQLite | 事务性 |
| Skill 文件 | 文件系统 | Claude Code 直接读取 |

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/evolution/post-response-analyzer.ts` | 重构 — 双路输出（memory + skill patch） |
| `src/kernel/evolution/knowledge-router.ts` | 重构 → `SystemPromptBuilder`，冻结快照 |
| `src/kernel/sessioning/session-manager.ts` | 扩展 — 冻结 context、session 持久化 |
| `src/kernel/memory/memory-retriever-v2.ts` | 新增 — `buildSnapshot()` 生成 MEMORY.md |
| `src/kernel/memory/reflection-agent.ts` | 新增 — 后台反思调度和执行 |
| `src/kernel/memory/session-store.ts` | 新增 — SQLite session 历史 + FTS |
| `mcp-servers/memory/index.ts` | 扩展 — 新增 session_search tool |
| `infra/database/schema.ts` | 扩展 — session_messages 表 |

## 备选方案

### 不做冻结快照

每轮重新加载 AIEOS + 检索 memory，实时性更好但：
- prefix cache 命中率低
- 会话中 memory 被其他 session 修改可能导致行为不一致
- 每轮检索开销大

**决策**：采用冻结快照 + compaction 时重建的策略。

### 反思在主链路同步执行

不 spawn 独立 session，直接在 `PostResponseAnalyzer` 中用 LLM 做深度分析。

问题：
- 增加用户等待时间
- 阻塞后续消息处理
- 上下文有限（只看当前轮，无法跨会话）

**决策**：后台异步反思，不影响用户体验。

## 验收标准

- [ ] Memory 和 Skill 写入路径分离
- [ ] Session 开始时冻结 context，会话内 system prompt 不因 memory 变化而重建
- [ ] MEMORY.md 自动生成，≤200 行 / ≤800 tokens
- [ ] 后台反思在 session 关闭后自动触发（满足条件时）
- [ ] `session_search` MCP tool 支持关键词跨会话检索
- [ ] Session 历史持久化到 SQLite，FTS5 索引可用
- [ ] `bun run check:all` 通过

## 参考

- `docs/hermes-agent/Hermes_Agent_research_1.md` — 五阶段自进化循环
- `docs/hermes-agent/Hermes_Agent_research_2.md` — Memory Provider 和 Skill 系统
- Claude Code `/dream` skill — 后台记忆整合的 4 阶段设计
- hermes-agent `agent/memory_manager.py` — Manager + Provider 模式
