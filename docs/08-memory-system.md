# 第8章 记忆系统

> 本章描述当前代码里的真实实现，不是旧方案草图。范围覆盖记忆的生成、存储、检索、注入、反思、长期沉淀，以及 MCP 对外暴露的消费路径。

## 8.1 总览

当前项目的“记忆模块”不是单一组件，而是 4 类存储和 3 条处理链路协作：

| 层 | 作用 | 主要实现 | 存储介质 | 典型内容 |
| --- | --- | --- | --- | --- |
| 运行时工作记忆 | 保存当前会话最近消息，必要时压缩 | `src/kernel/memory/working-memory.ts` | 进程内内存 | 最近轮次消息、压缩摘要 |
| 会话历史记忆 | 持久化原始对话和会话摘要 | `src/kernel/memory/session-store.ts` | SQLite + FTS5 | 原始消息、媒体描述、会话摘要、反思状态 |
| 长期语义记忆 | 语义检索、资源索引、关系链接、会话 commit 后抽取 | `src/kernel/memory/openviking/*` | OpenViking / VikingFS | 长期事实、偏好、资源、语义索引、关系 |
| 配置型长期记忆 | 稳定影响系统行为的身份/规则/用户画像 | `src/kernel/prompt/config-loader.ts` `src/kernel/prompt/user-config-loader.ts` | 本地 Markdown + VikingFS 镜像 | `SOUL.md` `IDENTITY.md` `USER.md` `AGENTS.md` |

补充说明：

- SQLite 负责“原文可追溯”和“精确关键词检索”。
- OpenViking 负责“语义召回”和“会话 commit 后的长期沉淀”。
- AIEOS Markdown 负责“稳定规则与身份”，本质上也是长期记忆，但更偏配置。
- 图谱没有单独数据库，`EntityManager` 直接复用 OpenViking 的文件和 relation 能力。

## 8.2 存储选型

### 8.2.1 为什么同时用内存、SQLite、OpenViking、Markdown

| 存储 | 选型原因 | 优点 | 限制 |
| --- | --- | --- | --- |
| 进程内内存 | 当前轮上下文必须低延迟 | 读写最便宜 | 进程退出即丢失 |
| SQLite | 原始会话日志需要本地持久化和全文检索 | 简单、快、FTS5 trigram 支持任意子串匹配、便于按用户过滤 | 不适合语义检索 |
| OpenViking | 长期记忆、资源、语义搜索、会话 commit | 已自带会话、搜索、关系、摘要接口 | 外部依赖，调用失败要降级 |
| Markdown 配置 | AIEOS 协议要求文件优先 | 可读、可编辑、可版本化 | 结构化程度弱，更新需约束格式 |

### 8.2.2 代码里的职责边界

- `WorkingMemory` 只解决“本次会话太长怎么办”。
- `SessionStore` 只保存“发生过什么”。
- `OpenVikingClient` 只封装外部记忆系统 HTTP API。
- `ConfigLoader` / `UserConfigLoader` 只解决配置型记忆的三级回退和同步。
- `SessionMemoryExtractor` 负责把会话提炼成摘要，但不直接写长期语义记忆。
- 真正把一整个 session 变成长期记忆的是 `ov.commit(sessionId)`。

## 8.3 记忆里到底存什么

### 8.3.1 运行时工作记忆

`WorkingMemory` 维护两类内容：

- `messages`: 当前还未压缩的消息
- `summaries`: 被压缩过的历史片段摘要

压缩策略是纯规则，不依赖 LLM：

- token 估算超过 `maxTokens * compressThreshold` 时触发
- 默认阈值 80%
- 将旧消息前半段切走，提炼成一个 `ContextSummary`
- 摘要保留首条、末条、以及包含动作词/疑问词的中间消息

### 8.3.2 SQLite 会话记忆

`SessionStore` 管理 3 组数据：

1. `sessions`
2. `session_messages`
3. `user_metadata`

关键字段：

| 表 | 字段 | 含义 |
| --- | --- | --- |
| `sessions` | `id/user_id/channel/conversation_id` | 会话主键和归属 |
| `sessions` | `started_at/ended_at/end_reason` | 生命周期 |
| `sessions` | `message_count/summary` | 会话关闭后的统计和摘要 |
| `sessions` | `reflection_processed` | 是否已经进入反思流程 |
| `session_messages` | `role/content/timestamp` | 原始对话文本 |
| `session_messages` | `token_estimate` | 粗粒度 token 估算 |
| `session_messages` | `media_refs_json` | 媒体引用描述，去掉 base64 |
| `user_metadata` | `last_reflection_at/reflection_count` | 反思调度状态 |

FTS5 虚表 `session_messages_fts` 用 **trigram tokenizer** 支持任意子串匹配（含中文），3+ 字符走索引，2 字符走 LIKE fallback。

### 8.3.3 OpenViking 长期记忆

项目通过 `OpenVikingClient` 使用这些能力：

- 文件系统：`read/abstract/overview/ls/tree/stat/write/mkdir`
- 搜索：`find/search/grep`
- 关系：`link/relations/unlink`
- 会话：`createSession/addMessage/commit`
- 资源：`addResource`

当前代码里长期记忆主要分 4 类：

- 用户长期记忆：`viking://user/default/memories/*`
- 用户配置：`viking://user/{userId}/config/*`
- 全局配置：`viking://agent/config/*`
- 外部资源：`viking://resources`

### 8.3.4 配置型记忆

AIEOS 四个文件属于“稳定记忆”：

| 文件 | 当前作用 |
| --- | --- |
| `IDENTITY.md` | 代理身份定义 |
| `SOUL.md` | 行为准则、Lessons Learned |
| `USER.md` | 用户画像/偏好 |
| `AGENTS.md` | 工程或代理运行指令 |

加载优先级：

1. 用户本地 `user-space/.../memory/*.md`
2. `viking://user/{userId}/config/*.md`
3. 全局 `config/*.md` 或 `viking://agent/config/*.md`

## 8.4 从生成到消费的完整生命周期

### 8.4.1 用户消息进入系统

入口在 `SessionManager.addMessage()` 和 `CentralController`：

1. `SessionManager.resolveSession()` 创建或复用 session
2. 新消息先进入 `session.messages`
3. 同步写入 `session.workingMemory.addMessage()`
4. 同步排队写入 `SessionStore.appendMessage()`
5. 最佳努力写入 OpenViking session：`ovClient.addMessage(session.id, 'user', content)`

这里有 3 个分支：

- 正常分支：内存、SQLite、OpenViking 三边都写入
- OV 失败分支：只记日志/静默跳过，内存和 SQLite 仍继续
- 媒体消息分支：先把媒体描述拼进文本，再写入 SQLite；原图 base64 不持久化

### 8.4.2 工作记忆压缩

当 `WorkingMemory` 估算 token 超阈值时：

1. 取旧消息前半段
2. 生成规则摘要
3. 摘要塞入 `summaries`
4. 剩余消息继续保留在 `messages`

注意：

- 这里只影响本进程上下文，不会直接写 SQLite 或 OpenViking。
- `ContextManager.checkAndFlush()` 还实现了另一条“Pre-Compaction Flush”链路：达到阈值时先 `ov.commit(sessionId)`，再检索关键记忆生成 anchor text。但当前主流程没有直接接上这条链路，更多是可复用能力和 fallback 预留。

### 8.4.3 会话关闭与会话摘要生成

`SessionManager.closeSession()` 会做 4 件事：

1. 调 `SessionMemoryExtractor.extract()` 提炼 `SessionSummary`
2. 写回 SQLite：`SessionStore.closeSession(session.id, reason, summary.summary)`
3. 触发 `onSessionClose` 回调
4. 返回摘要给上层

`SessionMemoryExtractor` 的提炼逻辑有两层：

- 默认规则提取：
  - `keywords`
  - `actionItems`
  - `preferences`
  - `summary`
- 可选 LLM 增强：
  - 仅当注入 `llmExtract`
  - 且消息数 `>= 5`
  - 失败则回退规则摘要

空会话分支：

- 如果 `session.messages.length === 0`，直接返回 `null`
- 不会生成摘要，不会进入后续 session close 处理链

### 8.4.4 会话 commit 到 OpenViking

`CentralController` 给 `SessionManager` 注册了 `onSessionClose` 回调。会话关闭后：

1. 先释放 harness worktree（如果有）
2. 调 `ovClient.commit(sessionId)`
3. 如果 commit 返回：
   - `status === 'accepted'`
   - 或 `memories_extracted > 0`
   就认为 commit 有效
4. 再用最近几条消息作为 query 去 `viking://user/default/memories` 检索，拿到一批 URI
5. 调 `evolutionScheduler.schedulePostCommit(extractedUris)`

这里的关键事实：

- `SessionMemoryExtractor` 负责会话摘要
- `ov.commit()` 负责真正把 session 交给 OpenViking 做长期记忆提取
- 这两件事是并列的，不是同一个模块做完

失败分支：

- `commit` 失败只记录 warning，不阻塞主流程
- commit 成功但找不到新 URI，也只会跳过 link，reflect 仍会被调度

### 8.4.5 进化链路：link / reflect / evolve / digest

#### A. link

`EvolutionScheduler.schedulePostCommit()` 会为每个 URI 调度 `link` 任务：

1. `linkMemory()` 读取新记忆内容
2. 用内容去 `ov.search()` 找相似记忆
3. 对得分 `> 0.75` 的结果调用 `ov.link()`

#### B. reflect

同一次 post-commit 还会固定调度 3 个类别：

- `facts`
- `preferences`
- `procedures`

`reflect()` 的逻辑：

1. 在对应目录搜索最多 50 条记忆
2. 少于 5 条直接跳过
3. 读取摘要片段，构造 prompt
4. 用注入的 `llmCall` 或 Anthropic SDK 提炼洞察
5. 把洞察写到 `viking://user/default/memories/semantic/*`

跳过分支：

- 同类记忆 `< 5` 条
- 未注入 `llmCall` 且没配 `ANTHROPIC_API_KEY`

#### C. evolve

`evolveMemory()` 是已实现的单条记忆演化能力：

1. 读取旧记忆
2. 用 LLM 判断关系：`SUPERSEDE/SUPPLEMENT/CONTRADICT/DUPLICATE`
3. 覆盖、合并或跳过

当前它是“可调度能力”，不是主会话链路里默认必走分支。

#### D. digest

digest 代码存在，但接入状态要区分：

- `digest-pipeline.ts` 已实现 `scan -> cluster -> distill -> write`
- `digest-trigger.ts` 已实现触发条件判断
- `EvolutionScheduler.scheduleDigest()` 已有入口
- 但 `executeJob('digest')` 当前只打日志，未真正打通 AgentBridge 执行

结论：

- digest 属于“已设计且部分实现”
- 不是当前主记忆生命周期中的默认执行分支

### 8.4.6 反思链路：从 SQLite 会话摘要到系统级 lesson

这条链路独立于 OpenViking commit。

触发条件由 `ReflectionTrigger` 控制：

- 从未反思过：未反思会话数 `>= 5`
- 反思过：距离上次反思 `>= 24h` 且未反思会话数 `>= 5`

触发后流程：

1. `SessionStore.getUnreflectedSessions(userId, 10)` 取最近待反思会话
2. `ReflectionPromptBuilder` 把会话摘要组装成系统任务文本
3. `taskDispatcher.dispatch()` 异步提交一条 `system` 任务
4. dispatch 成功后，立即：
   - `markReflectionProcessed(sessionId)`
   - `updateLastReflectionTime(userId, now)`

关键分支：

- 这里是“提交成功就标记已反思”，不是“任务真正执行完成再标记”
- 如果 dispatch 失败，不会标记 `reflection_processed`

### 8.4.7 用户纠错进入 Lessons Learned

这是另一条长期记忆链，目标是把“用户纠正”沉淀到 `SOUL.md`。

处理链：

1. agent 回答后，`PostResponseAnalyzer.analyzeExchange()`
2. `detectErrorSignal()` 判断用户是否在纠错/表达不满/重复要求
3. `extractLesson()` 用 LLM 或规则提取 lesson
4. `LessonsLearnedUpdater.addLesson()` 写回 `SOUL.md`

写入目标有两种：

- 有 `UserConfigLoader`：写用户空间 `SOUL.md`，并同步 `viking://user/{userId}/config/SOUL.md`
- 无 `UserConfigLoader`：写全局 `config/SOUL.md`，并同步 `viking://agent/config/SOUL.md`

`LessonsLearnedUpdater` 还负责：

- 去重
- 分类容量控制
- 总量控制

所以这条链是“配置型长期记忆更新”，不是 OpenViking semantic memory。

## 8.5 记忆如何被消费

### 8.5.1 每轮对话前的记忆注入

当前主路径分两层：

#### A. Frozen system prompt

`CentralController` 首轮构建 session 级 frozen prompt：

- `SystemPromptBuilder.build(...)`
- `buildMemorySnapshot([])`
- `buildPrependContext({ agentsConfig, userConfig })`

当前现状：

- `memorySnapshot` builder 已实现
- 但主流程传的是空数组
- 也就是“冻结系统提示支持记忆快照结构，但真实长期记忆尚未接入这一层”

#### B. Turn context

每轮都会调用 `buildTurnContext()`，其中记忆来自 `retrieveRelevantMemories(query, userId)` 的**双路并行检索**：

| 路径 | 后端 | 搜索方式 | 适合场景 |
| --- | --- | --- | --- |
| Path 1: OV 语义 | OpenViking | `ov.find()` memories(10) + resources(5) | 模糊主题、偏好、关系 |
| Path 2: FTS5 关键词 | SQLite | `SessionStore.searchMessages()` trigram | 精确数字、日期、人名、专有名词 |

两路结果合并排序取 top 10，注入 `<memory-context>` 段落。

`SessionStore.toFtsQuery()` 负责将自然语言转为 FTS5 MATCH 语法：按标点切分短语，3+ 字符走 trigram 索引，2 字符走 LIKE fallback。

降级分支：

- OV 或 FTS5 任一路径失败，另一路径仍然工作
- 两路都失败则返回空数组，本轮不注入长期记忆，不阻塞回答

### 8.5.2 SystemPromptBuilder 失败时的 fallback

如果 `SystemPromptBuilder` 失败，会回退到 `KnowledgeRouter.buildContext()`。

这条 fallback 更接近“完整记忆路由器”：

1. 加载 `IDENTITY/SOUL/USER/AGENTS`
2. 检索 OpenViking 长期记忆：`retrieveMemories()`
3. 合并 `WorkingMemory` summaries
4. 合并 `anchorText`
5. 合并最近消息和工作区信息
6. 做冲突消解和 token 分配
7. 拼装成单个 `systemPrompt`

也就是说：

- 主路径：轻量 per-turn 注入
- fallback 路径：重型上下文组装

### 8.5.3 MCP 工具消费

`mcp-servers/memory/index.ts` 暴露 6 个能力：

| 工具 | 读/写 | 后端 |
| --- | --- | --- |
| `viking_search` | 读 | OpenViking 语义检索 |
| `viking_read` | 读 | OpenViking 内容读取 |
| `viking_browse` | 读 | OpenViking 文件系统浏览 |
| `viking_remember` | 写 | OpenViking session + commit |
| `viking_add_resource` | 写 | OpenViking 资源导入 |
| `session_search` | 读 | SQLite FTS5 trigram + LIKE fallback |

其中 `viking_remember` 的写入路径很重要：

1. 临时创建一条 OV session
2. 写一条用户消息
3. 立即 `commit`
4. 让 OpenViking 自己提取长期记忆

所以它不是直接 `write(memoryUri, content)`，而是显式复用 OV 的会话提取能力。

### 8.5.4 图谱消费

`EntityManager` 不是主链路默认启用，但能力已存在：

- `upsertEntity()`
- `addRelation()`
- `linkToMemory()`
- `query(depth)`

选型上明确没有单独图数据库，全部复用 VikingFS + relations。

## 8.6 数据流总图

```text
用户消息
  -> SessionManager.resolveSession()
  -> SessionManager.addMessage()
     -> session.messages
     -> WorkingMemory.addMessage()
        -> 超阈值 ? compress() : 保持原样
     -> SessionStore.appendMessage()
        -> 批量刷入 SQLite
        -> FTS5 可检索原文
  -> ov.addMessage(session.id, role, content)  // best effort
  -> 回答前 retrieveRelevantMemories()  // 双路并行
     -> Path 1: ov.find(memories + resources)
     -> Path 2: SessionStore.searchMessages(FTS5 trigram)
     -> 合并排序 top 10
     -> buildTurnContext(<memory-context>)
  -> agent 输出
  -> PostResponseAnalyzer
     -> detectErrorSignal()
     -> extractLesson()
     -> LessonsLearnedUpdater.addLesson()
        -> 用户 SOUL.md / 全局 SOUL.md
        -> VikingFS 同步
  -> 会话关闭 closeSession()
     -> SessionMemoryExtractor.extract()
     -> SessionStore.closeSession(summary)
     -> ov.commit(sessionId)
        -> OpenViking 提取长期记忆
     -> EvolutionScheduler.schedulePostCommit()
        -> link
        -> reflect
     -> ReflectionTrigger.shouldReflect()
        -> background reflection task
        -> markReflectionProcessed()
```

## 8.7 当前实现里的关键分支和未接通点

这些分支容易漏，单独列出：

1. `WorkingMemory` 压缩是本地行为，不等于长期记忆沉淀。
2. `SessionMemoryExtractor` 生成的是会话摘要，不直接写 OpenViking 长期记忆。
3. `ov.commit(sessionId)` 才是 session 到长期语义记忆的核心桥。
4. ~~`buildMemorySnapshot()` 已实现，但主流程当前传空数组~~ **已修复**：`fetchSnapshotMemories()` 从 `viking://user/default/memories` 拉取 top 30 记忆注入 frozen prompt。
5. ~~`retrieveRelevantMemories()` 当前只拿 `abstract + Date.now()`~~ **已修复**：改为 OV + FTS5 双路检索，合并排序取 top 10。
6. `ContextManager.checkAndFlush()` 已实现，但不在当前主回答链路里默认启用。
7. `digest` 管线存在，但 scheduler 里的执行仍是占位日志。
8. 反思任务是”dispatch 成功即标记已处理”，不是”任务完成再标记”。
9. Lessons Learned 写的是 AIEOS 配置记忆，不是 OV 语义记忆。
10. ~~原始文本精确召回依赖 SQLite FTS5，不走 OpenViking~~ **已修复**：per-turn 检索和 MCP session_search 均走 FTS5 trigram + LIKE fallback，与 OV 语义检索并行。

## 8.8 结论

当前记忆系统的真实形态可以概括成一句话：

> 用 `WorkingMemory` 维持当前对话，用 `SessionStore` 保存可追溯原文，用 `OpenViking` 做长期语义记忆与资源库，用 AIEOS Markdown 保存稳定规则和用户画像，再用反思与 lesson 流程把短期交互逐步沉淀为长期行为约束。

如果只看主链路，记忆生命周期是：

1. 消息进入内存和 SQLite
2. 最佳努力同步到 OpenViking session
3. 每轮回答前从 OpenViking 拉少量相关长期记忆
4. 会话结束生成摘要并 commit 到 OpenViking
5. 后台做 link / reflect / reflection / lessons learned

这就是当前代码里“从记忆生成到消费”的完整闭环。
