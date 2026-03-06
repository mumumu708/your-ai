# DD-006: 自我进化系统

- **状态**: Implemented
- **创建日期**: 2026-03-06

## 背景

YourBot 需要从每次对话中学习——检测用户纠正、提取经验教训、建立记忆间语义关联，并在有限的上下文窗口内智能分配知识。这套系统让 AI 助手持续进化而非停留在初始状态。

## 架构总览

```
┌──────────────────── 对话前 ────────────────────┐
│                                                 │
│  KnowledgeRouter.buildContext()                  │
│    ├── 加载 AIEOS 配置 (identity/soul/user)       │
│    ├── OpenViking 检索相关记忆                     │
│    ├── ConflictResolver 解决规则冲突               │
│    ├── TokenBudgetAllocator 分配 token 预算        │
│    └── assemblePrompt() → system prompt           │
│                                                 │
├──────────────────── 对话后 ────────────────────┤
│                                                 │
│  PostResponseAnalyzer.analyzeExchange()          │
│    ├── detectErrorSignal() 检测用户纠正            │
│    ├── extractLesson() 提取经验 (置信度 > 0.6)     │
│    └── LessonsUpdater.addLesson() 写入存储         │
│                                                 │
│  EvolutionScheduler.schedulePostCommit()         │
│    ├── linkMemory()  — 建立语义关联               │
│    ├── reflect()     — 提炼高阶洞察               │
│    └── evolveMemory()— 智能更新已有记忆            │
│                                                 │
└─────────────────────────────────────────────────┘
```

## 核心组件

### 1. KnowledgeRouter (src/kernel/evolution/knowledge-router.ts)

**职责**: 构建上下文化的 system prompt。编排知识加载、冲突解决和 token 分配。

**默认配置**:

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxContextTokens | 4000 | 最大上下文 token |
| identityBudgetRatio | 0.3 | 身份/人格预算占比 |
| memoryBudgetRatio | 0.5 | 记忆预算占比 |
| sessionBudgetRatio | 0.2 | 会话预算占比 |
| maxMemoryResults | 5 | 最大记忆检索条数 |
| minRelevanceScore | 0.1 | 最小相关性阈值 |

**构建流程** (buildContext):

```
simple 复杂度:
  → 仅加载 identity + soul (30% token 预算)

complex 复杂度:
  1. 加载 AIEOS 配置 (identity/soul/user)
  2. 逐行分类 SOUL 规则 (safety/compliance → priority 10, 其他 → 6)
  3. 逐行分类 USER 规则 (preference/style → priority 8, 其他 → 7)
  4. 构建搜索查询 (当前消息 + 最近 3 条用户消息各 50 字符)
  5. OpenViking 记忆检索 (带 token 预算约束)
  6. 添加压缩会话摘要
  7. 添加 Pre-Compaction 锚文本
  8. 添加近期上下文 (最近 5 条消息各 100 字符)
  9. 添加工作空间信息 (可用技能/最近使用的工具)
  10. ConflictResolver 解决冲突
  11. TokenBudgetAllocator 分配预算 (identity:30% / memory:50% / session:20%)
  12. assemblePrompt() 组装最终 prompt
```

**Prompt 组装格式**:

```
--- Agent Identity ---
{identity content}

--- Agent Soul ---
{soul rules}

--- User Profile ---
{user rules}

--- Memory ---
{retrieved memories}

--- Session ---
{session context}
```

### 2. TokenBudgetAllocator (src/kernel/evolution/token-budget-allocator.ts)

**职责**: 在有限 token 预算内智能分配各类知识片段。

**Token 估算**: `Math.ceil(text.length / 4)` (CHARS_PER_TOKEN = 4)

**三桶分配**:

```
knowledge fragments → 分入 3 个桶
  identity 桶: identity, soul, user 来源
  memory 桶:   memory 来源
  session 桶:  session, workspace 来源

每个桶按 priority 降序排列
贪心填充: 高优先级先入
部分适配: 剩余空间 > 10 tokens 时裁剪片段
未用预算: 重新分配给待填充的桶
```

**智能裁剪** (trimFragment):
- 在句子边界裁剪（支持中英文标点: `. ` `。` `！` `？` `\n`）
- 保留点位须 > 50% 最大字符数
- 裁剪后重新计算 token 数

### 3. ConflictResolver (src/kernel/evolution/conflict-resolver.ts)

**职责**: 检测和解决知识片段间的冲突。

**冲突对** (互斥规则):
- Brief vs Detailed
- Formal vs Casual
- Conservative vs Aggressive
- Chinese vs English

**规则分类** (classifyRule):
- safety — 安全相关关键词 (dangerous, forbidden, prohibited...)
- compliance — 合规关键词 (legal, regulation, policy...)
- style — 风格关键词 (tone, format, concise, verbose...)
- preference — 偏好关键词 (prefer, like, always, usually...)
- general — 以上都不匹配

**解决层级**:

```
规则 1: Safety/Compliance from SOUL/Identity → 总是获胜
规则 2: Style/Preference from USER → 覆盖 SOUL
规则 3: 更高 priority → 获胜
规则 4: 同 priority → 保留首个
```

**有效优先级映射**:

| 来源.分类 | 优先级 |
|-----------|--------|
| identity | 10 |
| soul.safety, soul.compliance | 10 |
| soul.general | 8 |
| soul.style | 6 |
| user.preference, user.style | 8 |
| user.general | 7 |
| memory | 4 |
| session | 2 |

### 4. PostResponseAnalyzer (src/kernel/evolution/post-response-analyzer.ts)

**职责**: 分析用户回复，检测纠正信号并提取经验。

**流程**:

```
analyzeExchange(userId, userMsg, assistantMsg, history, configLoader)
  → withTimeout(doAnalyze(), 3000ms)   ← 3 秒超时保护

doAnalyze()
  → detectErrorSignal(userMsg, history) ← 检测纠正信号
  → confidence >= 0.6?
    ├── 是 → extractLesson(signal) → lessonsUpdater.addLesson()
    │        → 生成确认消息:
    │            preference → "我记住了：{text}"
    │            instruction → "好的，我记住了：{text}"
    │            fact → "已记录：{text}"
    └── 否 → 返回 null
```

### 5. ErrorToRulePipeline (src/kernel/evolution/error-to-rule-pipeline.ts)

**职责**: 将检测到的错误信号转化为持久化经验。

```
processErrorSignal(userId, signal)
  → extractLesson(signal) → lessonsUpdater.addLesson(lesson)
  → 已存在 → "已存在类似教训，无需重复记录"
  → 新增 → 生成确认消息 (与 PostResponseAnalyzer 相同格式)
```

### 6. EvolutionScheduler (src/kernel/evolution/evolution-scheduler.ts)

**职责**: 异步后台任务调度器，执行记忆进化操作。

**并发控制**: 最大 2 个并行任务，队列排空策略。

**任务类型**: `reflect | link | evolve`，每个任务最多重试 1 次。

**调度入口**:

```
schedulePostCommit(extractedMemoryUris: string[])
  → 每个 URI 创建 link 任务
  → 为 ['facts', 'preferences', 'procedures'] 各创建 reflect 任务
  → 非阻塞入队 + 触发排空

scheduleEvolve(newContent, existingUri)
  → 创建单个 evolve 任务
```

### 7. 三种进化操作

#### reflect (src/kernel/evolution/reflect.ts)

**高阶洞察提炼**:

```
reflect(ov, category)
  → 查询该类别最多 50 条记忆
  → < 5 条 → 跳过（数据不足）
  → 获取每条记忆的 abstract
  → Claude Sonnet 分析 → 提取 2-3 条高阶洞察
  → 洞察写入 viking://user/memories/semantic/{slug}
```

#### evolve (src/kernel/evolution/evolve.ts)

**智能记忆更新**:

```
evolveMemory(ov, newContent, existingUri)
  → 读取已有记忆内容
  → Claude Sonnet 分类关系:
      SUPERSEDE   → 新内容替换旧内容
      SUPPLEMENT  → 新内容追加（--- 分隔）
      CONTRADICT  → 合并解决矛盾（以新信息为准）
      DUPLICATE   → 跳过（日志记录）
```

#### link (src/kernel/evolution/link.ts)

**语义关联建立**:

```
linkMemory(ov, newMemoryUri)
  → 获取新记忆的 abstract
  → 搜索最多 5 条相似记忆
  → 相似度 > 0.75 → 创建 VikingFS link
  → 标签: semantic_similarity:{score}
```

## 类型定义 (src/kernel/evolution/evolution-types.ts)

```typescript
type KnowledgeSource = 'identity' | 'soul' | 'user' | 'memory' | 'session' | 'workspace';
type RuleClassification = 'safety' | 'compliance' | 'style' | 'preference' | 'general';

interface KnowledgeFragment {
  source: KnowledgeSource;
  content: string;
  priority: number;
  tokens: number;
  category?: MemoryCategory;
  ruleClass?: RuleClassification;
}

interface ResolvedContext {
  systemPrompt: string;
  fragments: KnowledgeFragment[];
  totalTokens: number;
  conflictsResolved: ConflictResolution[];
  retrievedMemories: MemorySearchResult[];
}

type LifecycleAction =
  | { type: 'archive'; reason: string }
  | { type: 'merge'; targetId: string; reason: string }
  | { type: 'delete'; reason: string }
  | { type: 'keep' };
```

## 关键设计决策

1. **分层冲突解决** — Safety > Compliance > User Preference > General，确保安全规则不被用户偏好覆盖
2. **Token 预算管理** — 三桶分配 + 句子边界裁剪，最大化信息密度
3. **异步进化** — 不阻塞对话响应，后台执行 link/reflect/evolve
4. **并发控制** — 最多 2 个并行进化任务，防止资源耗尽
5. **3 秒超时** — PostResponseAnalyzer 的分析不能影响响应延迟
6. **Claude 辅助进化** — reflect 和 evolve 使用 Claude Sonnet 进行语义分析
7. **渐进学习** — 错误信号 → 经验提取 → 规则写入 → 下次加载

## 文件清单

| 文件 | 职责 | 行数 |
|------|------|------|
| knowledge-router.ts | 上下文构建编排器 | ~268 |
| token-budget-allocator.ts | Token 估算与分配 | ~160 |
| conflict-resolver.ts | 规则分类与冲突解决 | ~138 |
| evolution-scheduler.ts | 异步任务队列 | ~98 |
| post-response-analyzer.ts | 回复后分析 | ~93 |
| error-to-rule-pipeline.ts | 错误→规则转化 | ~48 |
| evolution-types.ts | 类型定义 | ~103 |
| reflect.ts | 高阶洞察提炼 | ~57 |
| evolve.ts | 智能记忆更新 | ~70 |
| link.ts | 语义关联建立 | ~38 |
