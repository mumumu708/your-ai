# DD-015: Skill 系统升级

- **状态**: Draft
- **作者**: Agent + 管理员
- **创建日期**: 2026-04-11
- **最后更新**: 2026-04-11
- **上游**: [DD-011](011-architecture-upgrade-v2.md)

## 背景

当前 Skill 系统的问题：

1. **Skill 只是 prompt 片段**：SKILL.md 内容直接注入 Claude Code，没有独立的执行能力声明
2. **无 Progressive Disclosure**：所有 skill 可能被全量注入，token 浪费
3. **无 Readiness Check**：skill 依赖的环境变量、工具、凭证没有声明和验证机制
4. **无自维护能力**：agent 发现 skill 步骤有误时无法自动修补
5. **Skill 配置硬编码**：用户无法在不修改 SKILL.md 的情况下自定义行为

参考系：
- hermes-agent：Skill = 目录包、frontmatter 元数据、readiness check、patch-first、skill 配置
- Claude Code：skill_listing（1% budget）、invoked_skills 压缩恢复、/skillify 捕获流程

## 目标

1. Skill 索引占 system prompt ≤1% context window（~2000 tokens）
2. Skill 完整内容按需加载（progressive disclosure）
3. Skill 声明依赖，执行前验证就绪状态
4. Agent 能自动修补发现问题的 skill（patch-first）
5. Skill 支持用户级配置
6. Compaction 后已激活 skill 自动恢复提示

## 非目标

- 不做 skill marketplace / 远程 skill 仓库
- 不做 skill 版本管理（git 已经做了）
- 不做 skill 间编排框架（通过 agent 自然语言编排即可）
- 不做 skill 沙箱隔离

## 方案

### 1. Skill 目录结构升级

```
skills/builtin/{category}/{skill-name}/
├── SKILL.md              # 入口：frontmatter + 行为指引
├── scripts/              # 确定性逻辑（TypeScript/Python 脚本）
├── references/           # 参考文档
├── templates/            # 输出模板
└── assets/               # 静态资源
```

#### Frontmatter 规范

```yaml
---
name: rss-digest
description: RSS 源定时消化，生成结构化摘要报告
version: 1.0.0
author: Agent

# 就绪检查
readiness:
  env:                              # 需要的环境变量
    - RSS_FEED_URLS
  tools:                            # 需要的 MCP tools
    - web_fetch
  credentials: []                   # 需要的凭证文件

# 平台和通道
platforms: [feishu, telegram, web]  # 支持的通道（空=全部）

# 元数据
metadata:
  tags: [信息消化, RSS, 定时任务]
  related_skills: [deep-research]   # 语义关联（非依赖）
  fallback_for: [信息摘要, 内容消化]  # 当用户提到这些场景时推荐

# 用户可配置项
config:
  - key: rss-digest.schedule
    description: 消化频率（cron 表达式）
    default: "0 8 * * *"
  - key: rss-digest.max_items
    description: 每次最多处理条目数
    default: 50
  - key: rss-digest.language
    description: 输出语言
    default: zh-CN
---
```

### 2. Progressive Disclosure

#### Phase 1: Skill Index（System Prompt，session 级缓存）

所有已就绪 skill 的索引注入 system prompt L4，预算 ≤ context window 的 1%：

```typescript
class SkillIndexBuilder {
  build(userId: string, channel: string): string {
    const skills = this.skillManager.listSkills();

    const lines = ['# 可用 Skills', '',
      '需要使用时通过 skill_view 工具加载完整内容。', ''];

    for (const skill of skills) {
      // 平台过滤
      if (skill.platforms.length > 0 && !skill.platforms.includes(channel)) {
        continue;
      }

      // 就绪检查
      const readiness = this.checkReadiness(skill);
      const status = readiness.ready ? '✅' : `⚠️ 缺少: ${readiness.missing.join(', ')}`;

      // 一行一个 skill
      lines.push(`- **${skill.name}**: ${skill.description} [${status}]`);
    }

    return this.truncateTobudget(lines.join('\n'));
  }

  private truncateTobudget(content: string): string {
    const budget = Math.floor(this.contextWindowSize * 0.01);
    // 按 skill 粒度裁剪，优先保留就绪的
    return this.fitWithinBudget(content, budget);
  }
}
```

示例输出（~300 tokens for 16 skills）：

```
# 可用 Skills

需要使用时通过 skill_view 工具加载完整内容。

- **rss-digest**: RSS 源定时消化，生成结构化摘要报告 [✅]
- **deep-research**: 联网深度研究和报告生成 [✅]
- **commit**: Git 提交辅助 [✅]
- **ai-paper-interpreter**: 论文解读和分析 [⚠️ 缺少: ARXIV_API_KEY]
- **skill-creator**: 创建新 skill [✅]
- **math-olympiad-tutor**: 数学奥赛引导式教学 [✅]
...
```

#### Phase 2: Skill 加载（Tool Result，按需）

通过 `skill_view` MCP tool 加载完整内容：

```typescript
// mcp-servers/skill/index.ts
const skillViewTool = {
  name: 'skill_view',
  description: '加载指定 skill 的完整内容（SKILL.md + 支持文件列表）',
  parameters: {
    name: { type: 'string', description: 'skill 名称' },
  },
  handler: async (args: { name: string }) => {
    const skill = skillManager.getSkill(args.name);
    if (!skill) return { error: `Skill "${args.name}" not found` };

    const readiness = checkReadiness(skill);
    const configValues = resolveSkillConfig(skill);

    let content = skill.content;  // SKILL.md body

    // 注入配置值
    if (configValues.length > 0) {
      content += '\n\n## 当前配置\n';
      for (const { key, value } of configValues) {
        content += `- ${key} = ${value}\n`;
      }
    }

    // 列出支持文件
    const files = listSupportingFiles(skill.dir);
    if (files.length > 0) {
      content += '\n\n## 支持文件\n';
      content += '以下文件可通过 Read 工具按需读取：\n';
      for (const f of files) {
        content += `- ${f.relativePath} (${f.description})\n`;
      }
    }

    // 就绪状态
    if (!readiness.ready) {
      content += `\n\n⚠️ 就绪问题：缺少 ${readiness.missing.join(', ')}`;
    }

    return { content, readiness };
  },
};
```

#### Phase 3: Skill 压缩恢复

当 Claude Code 内部 compaction 发生后，之前加载的 skill 内容可能丢失。通过 `invokedSkills` 追踪和恢复：

```typescript
// Session 状态追踪
interface SessionSkillState {
  invokedSkills: Set<string>;  // 本 session 已调用 skill_view 的 skill 名称
}

// Compaction 后的下一轮 turn context 中注入
function buildInvokedSkillsReminder(invokedSkills: Set<string>): string {
  if (invokedSkills.size === 0) return '';
  return `<invoked-skills>
以下 skills 在本会话中已被使用。上下文压缩后完整内容已移除。
如需再次使用，请通过 skill_view 重新加载：
${[...invokedSkills].map(s => `- ${s}`).join('\n')}
</invoked-skills>`;
}
```

### 3. Readiness Check

```typescript
interface SkillReadiness {
  env?: string[];           // 需要的环境变量
  tools?: string[];         // 需要的 MCP tools
  credentials?: string[];   // 需要的凭证文件
}

interface ReadinessResult {
  ready: boolean;
  missing: string[];
  details: {
    env: { name: string; present: boolean }[];
    tools: { name: string; available: boolean }[];
    credentials: { path: string; exists: boolean }[];
  };
}

function checkReadiness(skill: SkillEntry): ReadinessResult {
  const missing: string[] = [];
  const readiness = skill.frontmatter.readiness || {};

  // 环境变量检查
  const envChecks = (readiness.env || []).map(name => ({
    name,
    present: !!process.env[name],
  }));
  envChecks.filter(e => !e.present).forEach(e => missing.push(`env:${e.name}`));

  // MCP tool 检查
  const toolChecks = (readiness.tools || []).map(name => ({
    name,
    available: mcpRegistry.hasTool(name),
  }));
  toolChecks.filter(t => !t.available).forEach(t => missing.push(`tool:${t.name}`));

  // 凭证文件检查
  const credChecks = (readiness.credentials || []).map(path => ({
    path,
    exists: existsSync(resolvePath(path)),
  }));
  credChecks.filter(c => !c.exists).forEach(c => missing.push(`cred:${c.path}`));

  return {
    ready: missing.length === 0,
    missing,
    details: { env: envChecks, tools: toolChecks, credentials: credChecks },
  };
}
```

### 4. Patch-First 自维护

#### 行为指引（注入 AGENTS.md）

在 AGENTS.md 的操作手册中添加：

```markdown
## Skill 维护协议
当你在使用某个 skill 时发现以下情况，应在完成当前任务后立即修补：
- 步骤描述不准确或缺失
- 命令或 API 调用已过时
- 缺少关键的错误处理说明
- 配置默认值不合理

修补方式：通过 skill_manage 工具的 patch 操作。
只修补发现的具体问题，不要重写整个 skill。
```

#### skill_manage MCP Tool

```typescript
const skillManageTool = {
  name: 'skill_manage',
  description: '管理 skill：创建、修补、编辑、删除',
  parameters: {
    action: {
      type: 'string',
      enum: ['create', 'patch', 'edit', 'write_file', 'remove_file', 'delete'],
    },
    name: { type: 'string' },
    content: { type: 'string', description: '完整内容(edit) 或 patch 描述(patch)' },
    file_path: { type: 'string', description: 'write_file/remove_file 时的相对路径' },
  },
  handler: async (args) => {
    switch (args.action) {
      case 'patch': {
        // 智能修补：找到 SKILL.md 中的目标位置，应用局部更改
        const skill = skillManager.getSkill(args.name);
        const patched = applyPatch(skill.content, args.content);
        skillManager.updateSkill(args.name, { content: patched });
        return { success: true, message: `Patched ${args.name}` };
      }
      case 'create': {
        skillManager.addSkill(args.name, parseSkillContent(args.content));
        return { success: true, message: `Created ${args.name}` };
      }
      case 'write_file': {
        // 写入 skill 目录下的支持文件
        skillManager.writeFile(args.name, args.file_path, args.content);
        return { success: true };
      }
      // ... other actions
    }
  },
};
```

### 5. Skill 配置系统

#### 配置存储

```typescript
// 用户级配置存储在 OpenViking 或本地文件
// viking://user/{userId}/config/skill-config.json

interface SkillConfigStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  getAll(): Record<string, string>;
}
```

#### 配置注入

skill_view 加载 skill 时，自动解析 frontmatter 中的 config 声明，从 store 获取当前值，注入到 skill 内容中：

```markdown
## 当前配置
- rss-digest.schedule = 0 8 * * *
- rss-digest.max_items = 50
- rss-digest.language = zh-CN
```

#### 配置修改

用户通过对话自然语言修改：

```
用户：把 RSS 消化改成每天下午 6 点
Agent：好的，更新 rss-digest.schedule 为 "0 18 * * *"
       → skill_config_set("rss-digest.schedule", "0 18 * * *")
```

### 6. Skill 发现增强

#### fallback_for 语义匹配

```yaml
metadata:
  fallback_for: [信息摘要, 内容消化, RSS]
```

当 TaskGuidanceBuilder 识别到用户意图与 `fallback_for` 关键词匹配时，在 `<task-guidance>` 中推荐：

```markdown
<task-guidance>
推荐 skill: rss-digest（匹配"内容消化"场景）。请先 skill_view 加载。
</task-guidance>
```

#### 后台反思触发的 Skill 创建

参考 DD-012 的反思 agent：当 Phase 2（Gather）发现可复用的方法或流程时，通过 `skill_manage(action='create')` 创建新 skill。

创建后需要用户确认（通过下次对话时的主动提示）：

```
Agent：我在回顾近期对话时发现了一个可复用的模式——"飞书文档处理三步法"。
      已创建为 skill: feishu-doc-processor。
      要查看和确认吗？
```

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/kernel/skills/skill-manager.ts` | 重构 — frontmatter 解析、readiness check、配置注入 |
| `src/kernel/skills/skill-index-builder.ts` | 新增 — 生成 system prompt L4 索引 |
| `src/kernel/skills/skill-readiness.ts` | 新增 — 就绪检查逻辑 |
| `src/kernel/skills/skill-config-store.ts` | 新增 — 用户级配置存储 |
| `mcp-servers/skill/index.ts` | 新增 — skill_view + skill_manage MCP tools |
| `skills/builtin/*/SKILL.md` | 升级 — 添加 frontmatter（readiness、config、metadata） |
| `config/AGENTS.md` | 更新 — 添加 Skill 维护协议 |

## 备选方案

### 全量注入所有 Skill

每次都把所有 skill 完整内容放 system prompt。

问题：
- 16 个 skill 的完整 SKILL.md > 5000 tokens
- 绝大多数 skill 当轮不需要
- 浪费 context window

**决策**：Progressive disclosure（索引 + 按需加载）。

### Skill 独立运行时

Skill 不通过 Claude Code 执行，而是有独立的脚本运行时。

问题：
- 大幅增加架构复杂度
- 需要独立的状态管理、错误处理、重试机制
- 确定性脚本可以通过 Claude Code 的 terminal tool 执行

**决策**：Skill 的确定性部分（scripts/）由 Claude Code 通过 terminal 执行，不需要独立运行时。

## 验收标准

- [ ] Skill 索引占 system prompt ≤ 1% context window
- [ ] skill_view 按需加载完整 skill 内容
- [ ] 所有 builtin skill 添加 frontmatter（readiness + config + metadata）
- [ ] Readiness check 在索引构建时执行，不就绪的 skill 标注原因
- [ ] skill_manage MCP tool 支持 patch 操作
- [ ] AGENTS.md 包含 Skill 维护协议
- [ ] Compaction 后已激活 skill 有恢复提示
- [ ] Skill 配置可通过自然语言修改
- [ ] `bun run check:all` 通过

## 参考

- hermes-agent `agent/skill_commands.py` — Skill 扫描、平台过滤、配置注入
- hermes-agent `tools/skills_tool.py` — skill_view、skill_manage 工具
- Claude Code skill 机制 — skill_listing（1% budget）、invoked_skills 恢复
- Claude Code `/skillify` — 会话流程捕获为 skill 的 4 轮对话
