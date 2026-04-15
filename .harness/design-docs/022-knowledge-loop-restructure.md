# DD-022: 知识闭环重构 — 模块边界重划 + 消费路径补全

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-15
- **最后更新**: 2026-04-15
- **上游**: [DD-011](011-architecture-upgrade-v2.md)、[DD-012](012-memory-reflection-upgrade.md)、[DD-015](015-skill-system-upgrade.md)

## 背景

### 问题 1：模块职责混乱

`evolution/`、`memory/`、`lessons/`、`skills/` 四个模块在多次迭代后出现职责重叠和边界模糊：

| 模块 | 当前实际职责 | 问题 |
|------|------------|------|
| `evolution/` | 上下文工程 + 学习闭环 + 记忆进化 | God module，三个正交关注点耦合 |
| `lessons/` | 错误检测 + 经验提取 + 经验更新 | 是 evolution 学习闭环的核心管道，却放在 `src/` 顶层 |
| `memory/` | 存储/检索 + AIEOS 配置加载 | config-loader 属于上下文工程，不属于存储层 |
| `skills/` | Skill CRUD + 部署 | 与学习闭环完全断开，学到的方法无法自动成为 skill |

具体耦合点：

1. **`evolution/` 的三重身份**：
   - `knowledge-router.ts` + `token-budget-allocator.ts` + `conflict-resolver.ts` = 上下文工程（DD-018 `prompt/` 已部分接管）
   - `post-response-analyzer.ts` + `error-to-rule-pipeline.ts` = 学习闭环（调用 `lessons/` 的核心逻辑）
   - `evolve.ts` + `reflect.ts` + `link.ts` + `evolution-scheduler.ts` = 记忆进化

2. **`lessons/` 的位置错误**：
   - 只被 `evolution/post-response-analyzer` 调用
   - 依赖 `memory/config-loader` 写入 SOUL.md
   - 放在 `src/lessons/`（与 `gateway/`、`kernel/`、`shared/` 同级），违反分层原则

3. **`memory/config-loader` 的归属错误**：
   - 加载的是 AIEOS 协议文件（SOUL/IDENTITY/USER/AGENTS）
   - 消费者是 system prompt 组装（`prompt/` 和 `evolution/knowledge-router`）
   - 放在 `memory/` 里没有语义合理性

4. **`skills/` 的孤立**：
   - DD-012 已指出 "Memory 和 Skill 混为一谈"
   - evolution 学到的"方法/流程"只能存为 memory，无法自动 patch 到 skill
   - skill index 与 per-turn 记忆检索完全独立

### 问题 2：消费路径不完整

当前知识闭环的写入侧有分流设计（DD-012），但读取/消费侧存在三个断点：

```
写入: interaction → analyzer → { memory, skill_patch, correction }

消费:
  Session 冻结: SOUL.md(L2) + Skill Index(L4) + MEMORY.md(L5)
  Per-Turn:     <memory-context> (OpenViking query)
  On-Demand:    skill_view / memory_search (agent 主动调用)
```

**断点 1 — Skill 学到但没人推荐**：evolution 自动 patch 的 skill 出现在 Skill Index 里，但 `<task-guidance>` 的推荐逻辑基于 `taskType` 硬编码映射，不做语义匹配。用户遇到相关场景时 agent 不知道有这个 skill。

**断点 2 — Memory Snapshot 静态切片不完整**：`memory-snapshot-builder.ts` 只覆盖 3 个 category（preference/fact/context），memory-types 定义了 6 个。每类最多 5 条且无排序逻辑，大量积累的信息沦为死数据。

**断点 3 — 无主动消化路径**：产品定位要求"积累碎片后汇总、提炼、引导快速学习"。当前消费模式全是被动的（用户问→检索→回答）。DD-012 的后台反思偏向 memory 整合（merge/prune），缺少面向用户的主动消化输出。

### 产品定位映射

| 产品能力 | 涉及模块 | 读/写 |
|---------|---------|-------|
| 1. 信息积累 | memory（存）、prompt（消费） | 写+读 |
| 2. 深度探索 | skills（执行）| 读 |
| 3. 学习引导 | skills（执行）| 读 |
| 4. 碎片消化 | memory（存）、evolution/digest（消化）、prompt（推送） | 写+处理+读 |
| 5. 自我进化 | evolution（学习+反思+消化） | 写+处理 |
| 6. Skill 扩展 | skills（CRUD）、evolution（自动 patch） | 写+读 |

## 目标

1. 四个模块职责边界清晰，每个模块只有一个核心关注点
2. `lessons/` 吸收进 `evolution/`，消除跨层依赖
3. `config-loader` 迁入 `prompt/`，存储层不再负责上下文组装
4. Skill 语义推荐接入 per-turn 消费路径
5. Memory Snapshot 按 importance × recency 排序，覆盖完整 category
6. 主动消化路径（digest）作为 evolution 的新子模块落地

## 非目标

- 不改变 OpenViking 存储引擎
- 不改变 DD-012 的冻结快照机制（只优化 snapshot 内容质量）
- 不改变 DD-015 的 Skill 目录结构和 frontmatter 规范
- 不做 skill 间编排框架
- 不做实时 memory 更新（保持会话内冻结语义）

## 方案

### Part 1: 模块边界重划

#### 1.1 重构后的模块职责

```
src/kernel/
├── memory/              "WHAT I know" — 纯存储 + 检索
│   ├── openviking/         向量/图存储客户端（不变）
│   ├── session-store.ts    会话持久化（不变）
│   ├── memory-retriever-v2.ts  检索（不变）
│   ├── working-memory.ts   工作记忆（不变）
│   └── graph/              实体关系图（不变）
│
├── prompt/              "WHAT to tell the agent" — 上下文工程
│   ├── system-prompt-builder.ts      已有（DD-018）
│   ├── prepend-context-builder.ts    已有（DD-018）
│   ├── turn-context-builder.ts       已有（DD-018）
│   ├── memory-snapshot-builder.ts    已有 → 升级（断点2）
│   ├── config-loader.ts              ← 从 memory/ 迁入
│   ├── user-config-loader.ts         ← 从 memory/ 迁入
│   └── conflict-resolver.ts          ← 从 evolution/ 迁入
│
├── evolution/           "HOW I improve" — 学习 + 进化 + 消化
│   ├── learning/           学习闭环（吸收 lessons/）
│   │   ├── error-detector.ts           ← 从 src/lessons/ 迁入
│   │   ├── lesson-extractor.ts         ← 从 src/lessons/ 迁入
│   │   ├── lessons-updater.ts          ← 从 src/lessons/ 迁入
│   │   └── post-response-analyzer.ts   ← 从 evolution/ 根目录移入
│   ├── reflection/         后台反思（DD-012，不变）
│   │   ├── reflection-trigger.ts
│   │   └── reflection-prompt-builder.ts
│   ├── memory-evolution/   记忆整合（不变）
│   │   ├── evolve.ts
│   │   ├── reflect.ts
│   │   └── link.ts
│   ├── digest/             主动消化（新增，断点3）
│   │   ├── digest-trigger.ts
│   │   ├── digest-pipeline.ts
│   │   └── digest-prompt-builder.ts
│   └── evolution-scheduler.ts  统一调度
│
├── skills/              "WHAT I can do" — 能力管理
│   ├── skill-manager.ts            CRUD（不变）
│   ├── skill-deployer.ts           部署（不变）
│   ├── skill-readiness.ts          就绪检查（不变）
│   ├── skill-index-builder.ts      索引构建 → 升级（断点1）
│   ├── skill-frontmatter.ts        前端解析（不变）
│   └── skill-patcher.ts            新增：接收 evolution 的 SkillPatch
│
└── (删除 src/lessons/)    整体吸收进 evolution/learning/
```

#### 1.2 迁移清单

| 文件 | 从 | 到 | 变更类型 |
|------|----|-----|---------|
| `config-loader.ts` | `kernel/memory/` | `kernel/prompt/` | 移动，更新 import |
| `user-config-loader.ts` | `kernel/memory/` | `kernel/prompt/` | 移动，更新 import |
| `conflict-resolver.ts` | `kernel/evolution/` | `kernel/prompt/` | 移动，更新 import |
| `error-detector.ts` | `src/lessons/` | `kernel/evolution/learning/` | 移动，更新 import |
| `lesson-extractor.ts` | `src/lessons/` | `kernel/evolution/learning/` | 移动，更新 import |
| `lessons-updater.ts` | `src/lessons/` | `kernel/evolution/learning/` | 移动，更新 import |
| `manual-management.ts` | `src/lessons/` | `kernel/evolution/learning/` | 移动，更新 import |
| `post-response-analyzer.ts` | `kernel/evolution/` | `kernel/evolution/learning/` | 移动到子目录 |
| `error-to-rule-pipeline.ts` | `kernel/evolution/` | `kernel/evolution/learning/` | 移动到子目录 |
| `knowledge-router.ts` | `kernel/evolution/` | 删除 | 职责已被 prompt/ 接管 |
| `token-budget-allocator.ts` | `kernel/evolution/` | 删除或迁入 prompt/ | 评估是否仍需要 |

#### 1.3 knowledge-router 拆解

`knowledge-router.ts` 当前是 evolution/ 中连接数最多的节点（29 edges），承担：

- 加载 AIEOS 配置 → 迁入 `prompt/config-loader`（已完成）
- 检索 memory → 由 `prompt/turn-context-builder` 调用 `memory/memory-retriever-v2`
- 分配 token 预算 → 参数化到 `memory-retriever-v2.RetrieveOptions.tokenBudget`
- 解决冲突 → 迁入 `prompt/conflict-resolver`
- 构建 skill 索引 → 由 `prompt/system-prompt-builder` 调用 `skills/skill-index-builder`

拆解后 `knowledge-router.ts` 不再需要作为独立文件存在。DD-018 的 `prompt/` 模块已覆盖其编排职责。

#### 1.4 evolution → skills 连接管道

```typescript
// evolution/learning/post-response-analyzer.ts 输出
interface AnalysisResult {
  memories: MemoryCandidate[];     // → OpenViking memory_store
  skillPatches: SkillPatch[];      // → skills/skill-patcher.ts
  corrections: Correction[];       // → evolution/learning/lessons-updater
}

// skills/skill-patcher.ts
interface SkillPatch {
  action: 'create' | 'update';
  skillName: string;               // e.g. "ts-type-error-debug"
  content: string;                 // SKILL.md 内容或 diff
  source: 'evolution';             // 标记来源
  confidence: number;              // 0-1, < 0.7 时不自动执行
}

// skill-patcher.ts 逻辑
async function applySkillPatches(patches: SkillPatch[]): Promise<void> {
  for (const patch of patches) {
    if (patch.confidence < 0.7) {
      // 低置信度：记录为 pending，等用户确认
      await storePendingPatch(patch);
      continue;
    }
    if (patch.action === 'create') {
      await skillManager.addSkill(patch.skillName, patch.content);
    } else {
      await skillManager.updateSkill(patch.skillName, patch.content);
    }
  }
}
```

### Part 2: 消费路径补全

#### 2.1 断点 1 修复 — Skill 语义推荐

**现状**：`<task-guidance>` 基于 `taskType` 硬编码推荐 skill，无语义匹配。

**方案**：Skill 索引构建时将 skill 描述存入 OpenViking，per-turn 检索时同时查 memory 和 skill。

```typescript
// skills/skill-index-builder.ts 升级
async function buildSkillIndex(ov: OpenVikingClient): Promise<SkillIndexEntry[]> {
  const skills = await skillManager.listSkills();
  const entries: SkillIndexEntry[] = [];

  for (const skill of skills) {
    const entry = {
      name: skill.name,
      description: skill.description,
      command: skill.command,
      tags: skill.tags,
      readiness: await checkReadiness(skill),
    };
    entries.push(entry);

    // 将 skill 描述写入 OpenViking 用于语义检索
    await ov.write(`viking://skills/${skill.name}`, {
      content: `${skill.description}\n${skill.tags?.join(', ') ?? ''}`,
      metadata: { type: 'skill_index' },
    });
  }

  return entries;
}

// prompt/turn-context-builder.ts 升级
async function buildTurnContext(params: TurnContextBuildParams): Promise<TurnContext> {
  // ... 现有逻辑 ...

  // 新增：Skill 语义匹配
  if (params.query) {
    const matchedSkills = await ov.find({
      query: params.query,
      target_uri: 'viking://skills',
      limit: 3,
    });

    if (matchedSkills.length > 0) {
      parts.push(buildSkillRecommendation(matchedSkills));
    }
  }

  // ...
}

function buildSkillRecommendation(matches: MatchedContext[]): string {
  const lines = ['<skill-recommendation>', '可能相关的 skill:'];
  for (const m of matches) {
    const name = m.uri.split('/').pop();
    lines.push(`- /${name}: ${m.content.slice(0, 80)}`);
  }
  lines.push('如需使用，调用 skill_view 获取完整内容。');
  lines.push('</skill-recommendation>');
  return lines.join('\n');
}
```

**Token 开销**：每轮额外 ~100-200 tokens（3 条推荐），在 per-turn 3000t 预算内。

#### 2.2 断点 2 修复 — Memory Snapshot 质量优化

**现状**：`memory-snapshot-builder.ts` 只有 3 个 category，每类固定 5 条，无排序。

**方案**：

```typescript
// prompt/memory-snapshot-builder.ts 升级

export interface MemoryItem {
  content: string;
  category: MemoryCategory;  // 使用完整的 6 个 category
  importance: number;         // 0-1
  updatedAt: number;          // timestamp
  accessCount?: number;       // 被检索命中的次数
}

export function buildMemorySnapshot(memories: MemoryItem[]): string {
  // 1. 按 importance × recency 综合排序
  const scored = memories.map(m => ({
    ...m,
    score: computeSnapshotScore(m),
  }));
  scored.sort((a, b) => b.score - a.score);

  // 2. 按 category 分组，每组动态分配条目数
  const grouped = groupByCategory(scored);
  const parts: string[] = ['# Memory Snapshot'];

  const categoryConfig: Record<string, { label: string; maxItems: number }> = {
    preference: { label: '用户偏好', maxItems: 5 },
    fact:       { label: '关键事实', maxItems: 5 },
    context:    { label: '项目上下文', maxItems: 4 },
    instruction:{ label: '行为指令', maxItems: 3 },
    insight:    { label: '总结洞察', maxItems: 3 },
    task:       { label: '活跃任务', maxItems: 3 },
  };

  for (const [cat, config] of Object.entries(categoryConfig)) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    parts.push('', `## ${config.label}`);
    for (const m of items.slice(0, config.maxItems)) {
      parts.push(`- ${m.content}`);
    }
  }

  return truncateSnapshot(parts.join('\n'));
}

function computeSnapshotScore(m: MemoryItem): number {
  const daysSinceUpdate = (Date.now() - m.updatedAt) / 86_400_000;
  const recencyDecay = Math.exp(-daysSinceUpdate / 30);  // 30天半衰期
  const accessBonus = Math.min((m.accessCount ?? 0) / 10, 0.3);
  return m.importance * 0.5 + recencyDecay * 0.3 + accessBonus * 0.2;
}
```

**约束不变**：≤200 行 / ≤800 tokens。

#### 2.3 断点 3 修复 — 主动消化路径（Digest）

**定位**：evolution 的第三个维度。当前 evolution 有"从错误中学习"（learning）和"从历史中整合"（reflection）。Digest 是"从积累中消化"——将未消化的碎片信息聚类、提炼、生成可消费的输出。

**与 DD-012 Reflection 的区别**：

| | Reflection（DD-012） | Digest（本 DD） |
|---|---|---|
| 关注点 | Memory 质量（merge/prune/link） | 碎片信息价值提取 |
| 输入 | 全量 memory + session 历史 | 近期未消化的 memory 碎片 |
| 输出 | 更新 MEMORY.md、删除旧 memory | 生成 insight 类 memory + 可选推送 |
| 面向 | 系统自身（内部优化） | 用户（外部价值） |
| 触发 | session 关闭后（定期） | 碎片累积阈值 / 用户命令 / 定时 |

#### Digest 触发条件

```typescript
interface DigestTrigger {
  // 满足任一即可触发：
  undigestedCount: number;           // 未消化碎片 ≥ 20 条
  daysSinceLastDigest: number;       // 距上次消化 ≥ 3 天
  manualTrigger: boolean;            // 用户命令触发（如 /digest）
}
```

#### Digest 执行流程

```
Phase 1: Scan（扫描）
├─ 查询 OpenViking 中 importance < 0.5 且未被标记为 digested 的 memory
├─ 查询近 N 天新增但 accessCount = 0 的 memory
└─ 收集结果作为 "待消化池"

Phase 2: Cluster（聚类）
├─ 对待消化池做向量聚类（OpenViking 相似度）
├─ 每个 cluster 提取 topic 关键词
└─ 过滤掉 cluster size < 3 的噪声

Phase 3: Distill（提炼）
├─ 对每个 cluster 调用 LLM 生成摘要/洞察
│   输入: cluster 内所有碎片的 content
│   输出: {
│     topic: string,           // 主题
│     insight: string,         // 提炼的洞察 (1-3 段)
│     questions: string[],     // 可能值得深入的问题
│     relatedSkills: string[], // 如果有相关 skill
│   }
├─ 将 insight 写入 OpenViking（category: 'insight', importance: 0.7）
└─ 标记原始碎片为 digested

Phase 4: Surface（呈现）
├─ 如果 insight 数量 ≥ 2：
│   └─ 在下次 session 的 per-turn 注入中添加提示：
│       <digest-available>
│       你最近积累了 {N} 条关于以下主题的信息：
│       - {topic1}: {insight_preview}
│       - {topic2}: {insight_preview}
│       如需了解详情，可以说"帮我梳理一下"或"消化一下最近的笔记"。
│       </digest-available>
└─ 如果用户响应 → 触发完整的消化报告输出
```

#### Digest 执行方式

与 DD-012 Reflection 一样，作为独立的后台 agent session 运行：

```typescript
async function runDigest(userId: string) {
  const digestPrompt = await buildDigestPrompt(userId);

  await agentBridge.execute({
    systemPrompt: DIGEST_SYSTEM_PROMPT,
    userMessage: digestPrompt,
    tools: ['memory_store', 'memory_search', 'memory_delete'],
    executionMode: 'async',
  });
}
```

#### 与 Scheduler 的集成

digest 通过 `evolution-scheduler.ts` 统一调度：

```typescript
// evolution-scheduler.ts 扩展
type EvolutionTask =
  | { type: 'reflect'; userId: string }   // DD-012
  | { type: 'evolve'; userId: string }    // 现有
  | { type: 'link'; userId: string }      // 现有
  | { type: 'digest'; userId: string };   // 新增

// 调度优先级：reflect > digest > evolve > link
```

### Part 3: 完整消费闭环

重构后的完整知识闭环：

```
                     ┌──────────────────────────┐
                     │       用户交互            │
                     └────────────┬─────────────┘
                                  │
                   ┌──────────────▼──────────────┐
                   │  WRITE: evolution/learning   │
                   │  post-response-analyzer      │
                   └──┬──────────┬──────────┬────┘
                      │          │          │
             事实/偏好  │   经验教训  │  方法/流程 │
                      ▼          ▼          ▼
                  OpenViking   SOUL.md    skills/
                  memory       §Lessons   skill-patcher
                      │          │          │
    ┌─────────────────┼──────────┼──────────┼──────────────────┐
    │                 READ: prompt/ 组装消费                     │
    │                                                           │
    │  Session 冻结层                                            │
    │  ┌───────────────────────────────────────────────────┐    │
    │  │ L2: SOUL.md (含 Lessons)                    ~800t │    │
    │  │ L4: Skill Index (名称+描述+readiness)       ~500t │    │
    │  │ L5: MEMORY.md (importance×recency 排序)     ~800t │    │
    │  └───────────────────────────────────────────────────┘    │
    │                                                           │
    │  Per-Turn 动态层                                           │
    │  ┌───────────────────────────────────────────────────┐    │
    │  │ <memory-context>: OpenViking find(query)           │    │
    │  │ <skill-recommendation>: Skill 语义匹配(query) [新] │    │
    │  │ <task-guidance>: 分类 + 整合 skill 推荐             │    │
    │  │ <digest-available>: 未消化洞察提示 [新]             │    │
    │  └───────────────────────────────────────────────────┘    │
    │                                                           │
    │  On-Demand 按需层                                          │
    │  ┌───────────────────────────────────────────────────┐    │
    │  │ skill_view → 完整 SKILL.md                         │    │
    │  │ memory_search → 深度 memory 检索                   │    │
    │  │ session_search → 跨会话历史检索                     │    │
    │  └───────────────────────────────────────────────────┘    │
    └───────────────────────────────────────────────────────────┘
                                  │
                   ┌──────────────▼──────────────┐
                   │  DIGEST: evolution/digest    │
                   │  后台异步，碎片 → 洞察        │
                   └──────────────┬──────────────┘
                                  │
                      ┌───────────▼───────────┐
                      │ insight 写回 memory    │
                      │ 下次 session 主动提示   │
                      └───────────────────────┘
```

## 与现有 DD 的关系

| DD | 本 DD 的影响 |
|----|-------------|
| DD-012 (记忆和反思) | 补充 digest 子模块；lessons 吸收到 evolution 后 learning 管道更清晰 |
| DD-015 (Skill 升级) | 新增 skill-patcher + skill 语义索引；不改变 frontmatter/readiness 设计 |
| DD-018 (Prompt Builder) | config-loader/conflict-resolver 迁入 prompt/；turn-context 新增 skill-recommendation |
| DD-011 (架构升级总纲) | 本 DD 是 DD-011 Phase 1 的横切优化，不改变总体时序 |

## 实施计划

与 DD-011 Phase 1 交织执行，不独立占一个 phase：

| 步骤 | 内容 | 搭车 DD | 风险 |
|------|------|---------|------|
| 1 | `config-loader` + `user-config-loader` 迁入 `prompt/`，更新所有 import | DD-018 | 低：纯移动 |
| 2 | `conflict-resolver` 迁入 `prompt/`，更新 import | DD-018 | 低：纯移动 |
| 3 | `src/lessons/` 整体迁入 `kernel/evolution/learning/`，更新 import | DD-012 | 低：纯移动 |
| 4 | `post-response-analyzer` + `error-to-rule-pipeline` 移入 `evolution/learning/` | DD-012 | 低：目录内移动 |
| 5 | 评估并清理 `knowledge-router.ts`（职责已被 prompt/ 接管的部分） | DD-018 | 中：需验证无残留依赖 |
| 6 | Memory Snapshot 排序优化（importance × recency） | DD-012 | 低：内部逻辑变更 |
| 7 | Skill 语义索引 + per-turn 推荐 | DD-015 | 中：需 OpenViking skill 命名空间 |
| 8 | evolution → skills 连接管道（SkillPatch + skill-patcher） | DD-012 + DD-015 | 中：新增跨模块接口 |
| 9 | Digest 子模块实现 | DD-012 | 高：新功能，需 LLM 调用 |
| 10 | `token-budget-allocator.ts` 评估去留 | DD-018 | 低：可能合并到 retriever 参数 |

步骤 1-4 是纯文件移动，可以作为一个 PR 批量执行。步骤 5-10 各自独立。

## 验收标准

### 模块边界

- [ ] `src/lessons/` 目录删除，所有文件迁入 `kernel/evolution/learning/`
- [ ] `memory/` 不再包含 `config-loader.ts` 和 `user-config-loader.ts`
- [ ] `evolution/` 不再包含 `conflict-resolver.ts`
- [ ] `knowledge-router.ts` 的上下文工程职责完全由 `prompt/` 接管
- [ ] 所有 import 更新完毕，`bun run check:all` 通过

### 消费路径

- [ ] Per-turn 注入包含 `<skill-recommendation>`（语义匹配 top 3）
- [ ] Memory Snapshot 覆盖 6 个 category，按 importance × recency 排序
- [ ] Digest 触发条件满足时自动执行后台消化
- [ ] 消化产生的 insight 在下次 session 通过 `<digest-available>` 主动提示
- [ ] evolution 学到的方法通过 `skill-patcher` 自动写入 skill 文件

### 测试验收

#### 单元测试

**evolution/learning/**

- [ ] `error-detector.ts`：纠错模式（"不是…"、"我是说…"）正确检测，false positive（"no problem"）正确过滤
- [ ] `error-detector.ts`：重复检测（Jaccard > 0.8）正确触发，相似但不同的消息不触发
- [ ] `lesson-extractor.ts`：rule-based fallback 对每种 ErrorSignal type 生成正确的 ExtractedLesson
- [ ] `lessons-updater.ts`：容量控制（20/category, 80 total）生效，超出时 FIFO 淘汰最旧条目
- [ ] `lessons-updater.ts`：Jaccard > 0.7 去重生效，相似 lesson 不重复写入
- [ ] `post-response-analyzer.ts`：AnalysisResult 三路分流正确——事实/偏好 → memories，经验 → corrections，方法/流程 → skillPatches

**skills/**

- [ ] `skill-patcher.ts`：confidence ≥ 0.7 的 patch 自动执行，< 0.7 的存为 pending
- [ ] `skill-patcher.ts`：create action 创建新 SKILL.md 文件，update action 更新已有文件
- [ ] `skill-index-builder.ts`：构建索引时 skill 描述写入 OpenViking `viking://skills/{name}` 命名空间

**prompt/**

- [ ] `config-loader.ts`：迁移后加载 AIEOS 4 文件行为不变（路径、缓存、回退逻辑）
- [ ] `conflict-resolver.ts`：迁移后冲突解决逻辑不变
- [ ] `memory-snapshot-builder.ts`：覆盖 6 个 category（preference/fact/context/instruction/insight/task）
- [ ] `memory-snapshot-builder.ts`：`computeSnapshotScore` 排序正确——高 importance + 近期 + 高 accessCount 的条目排在前面
- [ ] `memory-snapshot-builder.ts`：输出不超过 200 行 / 800 tokens
- [ ] `turn-context-builder.ts`：当 skill 语义匹配有结果时，输出包含 `<skill-recommendation>` 块

**evolution/digest/**

- [ ] `digest-trigger.ts`：undigestedCount ≥ 20 触发，daysSinceLastDigest ≥ 3 触发，两者独立满足即可
- [ ] `digest-pipeline.ts`：cluster size < 3 的噪声被过滤
- [ ] `digest-pipeline.ts`：生成的 insight 写入 OpenViking 时 category = 'insight'，importance = 0.7

#### 集成测试（需检查数据结果）

**学习管道集成**

- [ ] INT-01: 模拟用户纠错消息 → PostResponseAnalyzer 完整管道 → 验证 SOUL.md 文件中 `## Lessons Learned` 新增对应条目（读取文件内容断言）
- [ ] INT-02: 模拟用户纠错消息含可复用方法 → PostResponseAnalyzer → 验证 SkillPatch 传递到 skill-patcher → 验证 `skills/{name}/SKILL.md` 文件已创建且内容正确
- [ ] INT-03: 连续发送 21 条同 category 的 lesson → 验证 SOUL.md 中该 category 最多 20 条，最旧的被淘汰（读取并解析文件内容）

**Memory Snapshot 集成**

- [ ] INT-04: 写入 30 条不同 category/importance/updatedAt 的 memory → 调用 buildMemorySnapshot → 验证输出中 6 个 category 都出现（如有数据）、排序符合 importance×recency 公式、总行数 ≤ 200
- [ ] INT-05: 写入大量低 importance 旧数据 + 少量高 importance 新数据 → 验证 snapshot 优先包含后者（对比 content 列表）

**Skill 语义推荐集成**

- [ ] INT-06: 注册 3 个 skill（含描述）→ 构建 skill index 写入 OpenViking → 发送语义相关的 query → 验证 turn-context 输出包含 `<skill-recommendation>` 且推荐的 skill name 正确
- [ ] INT-07: 发送与所有 skill 都不相关的 query → 验证 turn-context 输出不包含 `<skill-recommendation>`

**Digest 集成**

- [ ] INT-08: 写入 25 条 importance < 0.5 且 accessCount = 0 的 memory → 触发 digest → 验证 OpenViking 中新增 category='insight' 的记录、原始 25 条标记为 digested
- [ ] INT-09: 写入 5 条碎片（< 20 阈值）→ 验证 digest 不触发
- [ ] INT-10: digest 完成后模拟新 session 创建 → 验证 per-turn 注入包含 `<digest-available>` 块且 topic 列表正确

**模块迁移回归**

- [ ] INT-11: config-loader 迁移后 → 通过 prompt/ 路径加载 AIEOS → 验证 4 个文件内容与迁移前一致（逐字段对比）
- [ ] INT-12: lessons 迁移后 → 通过 evolution/learning/ 路径执行完整纠错管道 → 验证输出与迁移前一致

#### 端到端测试（模拟用户发消息，检查数据结果）

- [ ] E2E-01: **纠错→学习→冻结闭环**
  1. 用户发送消息 "用 Python 帮我写个脚本"
  2. 助手回复
  3. 用户发送纠错 "不是 Python，以后都用 TypeScript"
  4. 验证：SOUL.md `## Lessons Learned` 包含 TypeScript 偏好条目（读取文件断言）
  5. 验证：OpenViking 中存在对应 memory（调用 find 查询断言）
  6. 模拟新 session 创建
  7. 验证：新 session 冻结区 system prompt 包含该 lesson 文本（检查 frozenContext.soul 字段）

- [ ] E2E-02: **方法学习→Skill 自动创建→推荐闭环**
  1. 用户多轮对话中反复使用某个调试方法（模拟 3 轮含调试步骤的对话）
  2. PostResponseAnalyzer 检测到可复用方法
  3. 验证：`skills/{auto-name}/SKILL.md` 文件已创建（检查文件存在 + 内容含方法步骤）
  4. 验证：OpenViking `viking://skills/{auto-name}` 有索引记录（调用 find 断言）
  5. 用户在新 session 中发送语义相关的问题
  6. 验证：per-turn 注入的 `<skill-recommendation>` 中包含该 skill name

- [ ] E2E-03: **碎片积累→消化→主动提示闭环**
  1. 模拟用户在多个 session 中发送 25 条零散信息（同一主题领域，如 "Rust 的所有权"相关碎片）
  2. 验证：OpenViking 中有 25 条对应 memory（调用 find 查询，断言 count）
  3. 触发 digest（模拟条件满足或手动触发）
  4. 验证：OpenViking 中新增 category='insight' 的记录，content 包含 "Rust" 或 "所有权"（读取并断言内容）
  5. 验证：原始 25 条 memory 已标记为 digested（查询 metadata 断言）
  6. 模拟新 session 创建
  7. 验证：首轮 per-turn 注入包含 `<digest-available>` 块，topic 中包含 "Rust" 相关文本

- [ ] E2E-04: **完整闭环压力测试**
  1. 模拟 10 个 session，每个 session 5 轮对话，包含：纠错、信息积累、方法使用
  2. 验证：SOUL.md lessons 数量不超过 80 条上限
  3. 验证：Memory Snapshot 不超过 200 行 / 800 tokens
  4. 验证：Skill 文件系统中存在 evolution 自动创建的 skill（至少 1 个）
  5. 验证：digest 至少执行 1 次，产生至少 1 条 insight
  6. 验证：所有存储（OpenViking、SOUL.md、Skill 文件、SQLite session）数据一致，无悬挂引用

## 参考

- [DD-011](011-architecture-upgrade-v2.md) — 架构升级总纲
- [DD-012](012-memory-reflection-upgrade.md) — 记忆和反思升级
- [DD-015](015-skill-system-upgrade.md) — Skill 系统升级
- [DD-018](018-system-prompt-builder.md) — System Prompt 组装器
- `docs/hermes-agent/` — Hermes Agent 调研（Memory vs Skill 分工）
