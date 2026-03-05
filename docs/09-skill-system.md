# 第9章 技能系统
> **版本变更说明**：本章内容已根据架构优化方案全面重写。YourBot 不再自建技能发现、注册、路由、注入、热更新等管理组件，而是**完全复用 Claude Code 原生的 Custom Slash Commands 机制**。YourBot 的职责收敛为：工作空间初始化时将技能文件部署到 `.claude/commands/` 目录，以及管理技能文件的 CRUD 操作。
---

## 9.1 技能系统架构变更说明
### 9.1.1 设计背景与架构演进
在前一版设计中，YourBot 构建了一套完整的自建技能管理体系，包括：
- `SkillDiscovery`（文件系统扫描发现技能）
- `SkillParser`（gray-matter 解析 SKILL.md frontmatter）
- `SkillRegistry`（Map 注册表 + 斜杠命令索引）
- `SkillRouter`（斜杠命令精确匹配 + 语义 Embedding 匹配）
- `SkillInjector`（将技能内容注入 System Prompt）
- `SkillFileWatcher`（fs.watch 监听 + 300ms 防抖热更新）
- `SkillLifecycleManager`（顶层生命周期编排器）

这套方案虽然功能完备，但本质上是在**重建 Claude Code 已经原生提供的能力**。

Claude Code 原生提供的技能（Commands）机制包括：
- **自动发现**：Claude Code 启动时自动扫描 `.claude/commands/` 目录下的所有 `.md` 文件；
- **斜杠命令注册**：文件名即命令名，如 `deploy-staging.md` 自动注册为 `/deploy-staging`；
- **参数支持**：通过 `$ARGUMENTS` 占位符接收用户输入；
- **内容注入**：命令文件的 Markdown 内容自动作为 Prompt 注入到对话上下文；
- **层级支持**：子目录中的命令自动注册为带冒号的命令，如 `devops/deploy.md` → `/devops:deploy`；
- **配套资源**：可在命令文件同目录下放置 `scripts/`、`assets/` 等辅助资源，在 Markdown 中引用；
- **热更新**：文件变更后自动生效，无需重启。

这意味着 YourBot 自建的 `SkillDiscovery`、`SkillParser`、`SkillRegistry`、`SkillRouter`、`SkillInjector`、`SkillFileWatcher`、`SkillLifecycleManager` **全部都是 Claude Code 已有能力的重复建设**。

### 9.1.2 新旧架构对比

| 维度 | 旧架构（自建管理体系） | 新架构（托管 Claude Code） |
| --- | --- | --- |
| 技能发现 | `SkillDiscovery` 扫描 `skills/` 目录 | Claude Code 自动扫描 `.claude/commands/` |
| 技能解析 | `SkillParser` 用 gray-matter 解析 frontmatter | Claude Code 原生解析 Markdown 内容 |
| 命令注册 | `SkillRegistry` 维护 Map 索引 | 文件名即命令名，自动注册 |
| 命令匹配 | `SkillRouter`（精确匹配 + 语义 Embedding） | Claude Code 原生斜杠命令匹配 |
| 内容注入 | `SkillInjector` 构建 XML 标签注入 System Prompt | Claude Code 原生将命令内容作为 Prompt 注入 |
| 热更新 | `SkillFileWatcher` (fs.watch + 防抖) | Claude Code 原生文件变更检测 |
| 生命周期管理 | `SkillLifecycleManager` 协调全流程 | **无需管理，Claude Code 全部接管** |
| YourBot 代码量 | ~800 行（7 个组件） | **~50 行（仅文件部署逻辑）** |

### 9.1.3 新架构总体视图
```plaintext
┌─────────────────────────────────────────────────────┐
│                   YourBot Platform                   │
│                                                      │
│  ┌──────────────────┐  ┌───────────────────────────┐ │
│  │ Workspace Init   │  │  技能管理 API             │ │
│  │ (技能文件部署)    │  │  (CRUD 操作)             │ │
│  │                  │  │                           │ │
│  │ 复制技能文件到:   │  │  POST /skills → 写入文件  │ │
│  │ .claude/commands/ │  │  DELETE /skills → 删除   │ │
│  └────────┬─────────┘  └─────────────┬─────────────┘ │
│           │                          │               │
│           ▼                          ▼               │
│  ┌─────────────────────────────────────────────────┐ │
│  │    .claude/commands/ 目录（技能文件存储）         │ │
│  │                                                  │ │
│  │  commands/                                       │ │
│  │  ├── commit.md             (基础技能)            │ │
│  │  ├── review-pr.md          (基础技能)            │ │
│  │  ├── deploy-staging.md     (高级技能)            │ │
│  │  ├── deploy-staging/                             │ │
│  │  │   ├── scripts/deploy.sh                      │ │
│  │  │   └── assets/k8s-template.yaml               │ │
│  │  └── ...                                        │ │
│  └──────────────────────┬──────────────────────────┘ │
│                         │                            │
│                         ▼                            │
│  ┌─────────────────────────────────────────────────┐ │
│  │       Claude Code（原生 Commands 引擎）          │ │
│  │                                                  │ │
│  │  自动发现 → 注册斜杠命令 → 匹配用户输入           │ │
│  │  → 注入 Prompt → Agent 执行 → 热更新             │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 9.1.4 核心设计原则
1. **完全托管原则**：技能的发现、注册、匹配、注入、热更新全部由 Claude Code 原生机制完成，YourBot 不再维护任何运行时技能管理组件；
2. **文件即技能**：一个 `.md` 文件 = 一个技能。文件名 = 斜杠命令名。无需额外的注册表或索引；
3. **零自定义执行器**（保持不变）：脚本执行完全依赖 Claude Code 内置的 Bash Tool、Read Tool、Write Tool；
4. **部署即生效**：将技能文件写入 `.claude/commands/` 目录后，Claude Code 自动识别和注册，无需任何额外的加载或初始化步骤。

---

## 9.2 Claude Code Commands 机制详解
### 9.2.1 原生 Commands 工作原理
Claude Code 的 Custom Slash Commands 是一套基于文件系统的技能定义机制：

```plaintext
用户输入 /deploy-staging
         │
         ▼
Claude Code 在 .claude/commands/ 目录中
查找 deploy-staging.md
         │
         ▼
读取文件内容，替换 $ARGUMENTS 为用户输入的参数
         │
         ▼
将文件内容作为用户消息注入对话上下文
         │
         ▼
Agent 根据注入的指令自主执行
（调用 Bash、Read、Write 等内置工具）
```

### 9.2.2 Commands 目录结构规范

Claude Code 支持两级 Commands 配置：

| 路径 | 作用域 | YourBot 用途 |
| --- | --- | --- |
| `.claude/commands/` | 项目级，工作空间内所有会话共享 | 部署内置技能 + 租户技能 + 用户自定义技能 |
| `~/.claude/commands/` | 全局级，所有项目共享 | 不使用（YourBot 的技能都是项目级的） |

YourBot 的技能统一部署在工作空间级 `.claude/commands/` 下：

```plaintext
{workspace}/.claude/commands/        # 技能根目录
├── commit.md                        # 基础技能：Git Commit 规范
├── review-pr.md                     # 基础技能：PR 审查
├── deploy-staging.md                # 高级技能：部署到预发环境
├── create-api.md                    # 高级技能：API 脚手架生成
│
├── deploy-staging/                  # 高级技能的配套资源目录
│   ├── scripts/                     # 可执行脚本
│   │   ├── pre-check.sh
│   │   ├── deploy.sh
│   │   └── notify.py
│   └── assets/                      # 静态资源
│       ├── k8s-template.yaml
│       └── slack-message.json
│
├── create-api/                      # 高级技能的配套资源目录
│   ├── scripts/
│   │   └── scaffold.ts
│   └── assets/
│       ├── controller.ts.hbs
│       ├── service.ts.hbs
│       └── route.ts.hbs
│
└── devops/                          # 分类子目录
    ├── scale.md                     # → /devops:scale
    └── rollback.md                  # → /devops:rollback
```

### 9.2.3 命名约束

| 约束项 | 规则 | 示例 |
| --- | --- | --- |
| 命令文件名 | 小写字母、数字、连字符（`-`），`.md` 后缀 | `deploy-staging.md` |
| 自动注册命令 | 文件名去掉 `.md` 后缀即为命令名 | `deploy-staging.md` → `/deploy-staging` |
| 子目录命令 | 子目录名 + 冒号 + 文件名 | `devops/scale.md` → `/devops:scale` |
| 资源目录 | 与命令文件同名的子目录（无 `.md`） | `deploy-staging/scripts/` |
| 脚本文件 | 位于资源目录 `scripts/` 下，支持 `.sh`、`.py`、`.ts` | `deploy-staging/scripts/deploy.sh` |
| 资源文件 | 位于资源目录 `assets/` 下，任意文件类型 | `deploy-staging/assets/template.yaml` |

### 9.2.4 基础技能 vs 高级技能

| 层级 | 组成 | 触发方式 | 示例 |
| --- | --- | --- | --- |
| **基础技能** | 仅 `.md` 文件 | `/命令名` 或 `/命令名 参数` | `/commit`、`/review-pr` |
| **高级技能** | `.md` 文件 + 同名资源目录（`scripts/` + `assets/`） | `/命令名` 或 `/命令名 参数` | `/deploy-staging main` |

判定逻辑：如果 `.claude/commands/` 下存在与命令文件同名的子目录且包含 `scripts/` 或 `assets/`，则为高级技能。

---

## 9.3 技能文件编写规范
### 9.3.1 文件结构
YourBot 的技能文件采用 **纯 Markdown** 格式，直接作为 Claude Code Command 的内容。文件中使用 `$ARGUMENTS` 占位符来接收用户传入的参数。

> **对比旧架构**：旧方案使用 YAML Frontmatter + Markdown Body 的 SKILL.md 格式，需要 `gray-matter` 库解析 frontmatter 元数据。新方案直接使用纯 Markdown，因为 Claude Code 的 Commands 机制不需要也不解析 frontmatter——文件内容整体作为 Prompt 注入。技能的元数据（名称、描述等）直接体现在 Markdown 正文中。

### 9.3.2 基础技能模板
```markdown
# Git Commit 规范助手

你是一个 Git 版本管理专家。请根据当前工作目录的变更生成符合 Conventional Commits 规范的提交信息。

用户需求：$ARGUMENTS

## 执行步骤

### 步骤 1：检查 Git 状态
使用 Bash 工具执行 `git status` 和 `git diff --cached`，了解当前暂存区的变更。

### 步骤 2：分析变更内容
根据 diff 内容，判断变更类型：
- `feat`: 新功能
- `fix`: 修复 Bug
- `docs`: 文档变更
- `style`: 代码格式调整
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

### 步骤 3：生成提交信息
按照以下格式生成提交信息：
```
<type>(<scope>): <subject>

<body>
```

### 步骤 4：执行提交
使用 Bash 工具执行 `git commit -m "<生成的提交信息>"`。

## 注意事项
- 如果暂存区为空，提示用户先使用 `git add` 添加文件
- Subject 行不超过 72 个字符
- Body 部分用中文描述变更的原因和影响
```

### 9.3.3 高级技能模板
```markdown
# 部署到预发环境

你是一个专业的 DevOps 工程师。当用户要求部署到预发环境时，请严格按照以下步骤执行。

部署参数：$ARGUMENTS

## 前置条件
- 当前目录必须是 Git 仓库
- 需要 Docker 已安装且 daemon 运行中
- 需要 kubectl 已配置且可访问目标集群

## 步骤 1：环境预检

首先执行预检脚本，确认部署条件满足：

```bash
bash ./.claude/commands/deploy-staging/scripts/pre-check.sh
```

如果预检失败，停止部署并报告失败原因。

## 步骤 2：构建 Docker 镜像

```bash
bash ./.claude/commands/deploy-staging/scripts/deploy.sh
```

## 步骤 3：Kubernetes 部署

使用 Read 工具读取部署模板：
```
./.claude/commands/deploy-staging/assets/k8s-template.yaml
```

将模板中的占位符替换为实际值后，使用 `kubectl apply` 部署。

## 步骤 4：健康检查

等待 60 秒后检查 Pod 状态：
```bash
kubectl get pods -l app=yourbot -n staging
```

## 步骤 5：通知

部署完成后，使用 feishu_send_message 工具通知相关人员。

## 错误处理
- 如果任何步骤失败，立即停止并报告
- 如果 Pod 启动失败，执行 `kubectl rollback` 回滚
- 记录所有操作日志到部署报告中
```

### 9.3.4 编写指南

编写技能 Markdown 文件时应遵循以下原则：

1. **角色设定**：在文件开头明确 Agent 应扮演的角色（如"你是一个专业的 DevOps 工程师"）；
2. **步骤化**：使用有序的标题层级（`## 步骤 1`、`## 步骤 2`）组织执行流程；
3. **参数占位**：使用 `$ARGUMENTS` 接收用户传入的参数，并说明预期的参数格式；
4. **工具引用明确**：当需要 Agent 调用工具时，使用代码块标注具体命令；
5. **路径引用**：脚本和资源使用相对于工作空间根目录的路径（`./.claude/commands/{skill-name}/scripts/xxx.sh`）；
6. **错误处理**：显式描述失败场景下的处理策略；
7. **输出格式**：定义最终输出的呈现格式，保持用户体验一致性。

---

## 9.4 高级技能：脚本+模板支持
### 9.4.1 脚本目录（scripts/）
高级技能的配套脚本存放在与命令文件同名的资源子目录下。支持的脚本类型：

| 类型 | 后缀 | 执行方式（Agent 通过 Bash Tool 调用） |
| --- | --- | --- |
| Shell 脚本 | `.sh` | `bash ./.claude/commands/{skill}/scripts/example.sh` |
| Python 脚本 | `.py` | `python3 ./.claude/commands/{skill}/scripts/example.py` |
| TypeScript 脚本 | `.ts` | `npx tsx ./.claude/commands/{skill}/scripts/example.ts` |

**关键设计决策**（保持不变）：平台不提供自定义脚本执行器。所有脚本执行均由 Claude Code Agent 通过其内置 Bash Tool 完成。技能 Markdown 中的指令文本引导 Agent 决定何时、以何种方式调用哪些脚本。

#### 脚本编写示例
`deploy-staging/scripts/pre-check.sh`：
```bash
#!/bin/bash
set -euo pipefail

echo "=== 部署预检开始 ==="

# 检查 Git 状态
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "ERROR: 当前目录不是 Git 仓库"
  exit 1
fi

# 检查 Docker
if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker daemon 未运行"
  exit 1
fi

# 检查 kubectl
if ! kubectl cluster-info > /dev/null 2>&1; then
  echo "ERROR: kubectl 无法连接到集群"
  exit 1
fi

echo "OK: 所有预检项通过"
```

### 9.4.2 资源目录（assets/）
`assets/` 目录存放技能所需的静态资源文件，Agent 通过 Read Tool 读取这些文件内容。

#### 模板文件示例
`deploy-staging/assets/k8s-template.yaml`：
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: yourbot-{{ENV}}
  namespace: {{NAMESPACE}}
  labels:
    app: yourbot
    environment: {{ENV}}
spec:
  replicas: {{REPLICAS}}
  selector:
    matchLabels:
      app: yourbot
  template:
    metadata:
      labels:
        app: yourbot
        version: "{{VERSION}}"
    spec:
      containers:
        - name: yourbot-app
          image: "registry.example.com/yourbot:{{IMAGE_TAG}}"
          ports:
            - containerPort: 8080
          env:
            - name: NODE_ENV
              value: "{{ENV}}"
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

---

## 9.5 技能部署机制
### 9.5.1 工作空间初始化时部署
技能文件在工作空间初始化阶段由 `SkillDeployer` 部署到 `.claude/commands/` 目录。这是一个纯文件复制操作，不涉及任何运行时注册或管理逻辑。

```typescript
// src/workspace/skill-deployer.ts

import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

interface SkillSource {
  /** 技能来源类型 */
  type: 'builtin' | 'marketplace' | 'custom';
  /** 技能文件/目录的源路径 */
  sourcePath: string;
}

class SkillDeployer {
  private readonly builtinSkillsDir = '/opt/yourbot/skills/builtin';
  private readonly marketplaceSkillsDir = '/opt/yourbot/skills/marketplace';

  /**
   * 将技能文件部署到工作空间的 .claude/commands/ 目录
   * 此方法在工作空间首次创建时调用一次
   */
  deploy(workspaceDir: string, context: WorkspaceContext): void {
    const commandsDir = join(workspaceDir, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });

    // 1. 部署内置技能
    this.deploySkillsFromDir(this.builtinSkillsDir, commandsDir);

    // 2. 部署租户配置的市场技能
    for (const skillId of context.tenantConfig.enabledSkills ?? []) {
      const skillPath = join(this.marketplaceSkillsDir, skillId);
      if (existsSync(skillPath)) {
        this.deploySkill(skillPath, commandsDir);
      }
    }

    // 3. 部署用户自定义技能
    const userSkillsDir = join('/data/yourbot/user-skills', context.userId);
    if (existsSync(userSkillsDir)) {
      this.deploySkillsFromDir(userSkillsDir, commandsDir);
    }

    console.log(`[SkillDeployer] 技能已部署到 ${commandsDir}`);
  }

  /**
   * 部署整个目录下的所有技能
   */
  private deploySkillsFromDir(sourceDir: string, targetDir: string): void {
    if (!existsSync(sourceDir)) return;

    const entries = readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

      const sourcePath = join(sourceDir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.md')) {
        // 基础技能：直接复制 .md 文件
        cpSync(sourcePath, join(targetDir, entry.name));
      } else if (entry.isDirectory()) {
        // 高级技能：复制整个目录
        this.deploySkill(sourcePath, targetDir);
      }
    }
  }

  /**
   * 部署单个技能（高级技能：.md 文件 + 资源目录）
   */
  private deploySkill(sourcePath: string, targetDir: string): void {
    const skillName = basename(sourcePath);

    if (statSync(sourcePath).isDirectory()) {
      // 高级技能目录：查找 SKILL.md 或 {skillName}.md，复制为命令文件
      const mdFile = existsSync(join(sourcePath, 'SKILL.md'))
        ? join(sourcePath, 'SKILL.md')
        : join(sourcePath, `${skillName}.md`);

      if (existsSync(mdFile)) {
        // 复制命令 Markdown 文件
        cpSync(mdFile, join(targetDir, `${skillName}.md`));
      }

      // 复制资源目录（scripts/ + assets/）
      const resourceDir = join(targetDir, skillName);
      const scriptsDir = join(sourcePath, 'scripts');
      const assetsDir = join(sourcePath, 'assets');

      if (existsSync(scriptsDir) || existsSync(assetsDir)) {
        mkdirSync(resourceDir, { recursive: true });
        if (existsSync(scriptsDir)) {
          cpSync(scriptsDir, join(resourceDir, 'scripts'), { recursive: true });
        }
        if (existsSync(assetsDir)) {
          cpSync(assetsDir, join(resourceDir, 'assets'), { recursive: true });
        }
      }
    }
  }
}
```

### 9.5.2 技能管理 API
运行时的技能增删操作通过简单的文件操作实现，变更后 Claude Code 自动识别：

```typescript
// src/api/skill-routes.ts

import { Hono } from 'hono';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join } from 'path';

const skillRoutes = new Hono();

/**
 * 添加技能到工作空间
 * POST /api/skills
 */
skillRoutes.post('/', async (c) => {
  const { workspaceDir, skillName, content, scripts, assets } = await c.req.json();
  const commandsDir = join(workspaceDir, '.claude', 'commands');
  mkdirSync(commandsDir, { recursive: true });

  // 写入命令 Markdown 文件
  const mdPath = join(commandsDir, `${skillName}.md`);
  writeFileSync(mdPath, content, 'utf-8');

  // 如果有配套资源，创建资源目录
  if (scripts || assets) {
    const resourceDir = join(commandsDir, skillName);
    mkdirSync(resourceDir, { recursive: true });

    if (scripts) {
      const scriptsDir = join(resourceDir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      for (const [name, scriptContent] of Object.entries(scripts)) {
        writeFileSync(join(scriptsDir, name), scriptContent as string, 'utf-8');
      }
    }

    if (assets) {
      const assetsDir = join(resourceDir, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      for (const [name, assetContent] of Object.entries(assets)) {
        writeFileSync(join(assetsDir, name), assetContent as string, 'utf-8');
      }
    }
  }

  // Claude Code 自动检测文件变更，无需额外通知
  return c.json({ success: true, command: `/${skillName}` });
});

/**
 * 删除技能
 * DELETE /api/skills/:name
 */
skillRoutes.delete('/:name', async (c) => {
  const { workspaceDir } = await c.req.json();
  const skillName = c.req.param('name');
  const commandsDir = join(workspaceDir, '.claude', 'commands');

  // 删除命令文件
  const mdPath = join(commandsDir, `${skillName}.md`);
  if (existsSync(mdPath)) {
    unlinkSync(mdPath);
  }

  // 删除资源目录
  const resourceDir = join(commandsDir, skillName);
  if (existsSync(resourceDir)) {
    rmSync(resourceDir, { recursive: true });
  }

  return c.json({ success: true });
});

/**
 * 列出工作空间中的所有技能
 * GET /api/skills
 */
skillRoutes.get('/', async (c) => {
  const workspaceDir = c.req.query('workspace')!;
  const commandsDir = join(workspaceDir, '.claude', 'commands');

  if (!existsSync(commandsDir)) {
    return c.json({ skills: [] });
  }

  const entries = readdirSync(commandsDir, { withFileTypes: true });
  const skills = entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => {
      const skillName = e.name.replace('.md', '');
      const resourceDir = join(commandsDir, skillName);
      const hasResources = existsSync(resourceDir);
      return {
        name: skillName,
        command: `/${skillName}`,
        tier: hasResources ? 'advanced' : 'basic',
      };
    });

  return c.json({ skills });
});

export { skillRoutes };
```

### 9.5.3 与工作空间初始化的集成
技能部署是工作空间初始化流程的一部分，与 MCP 配置生成（第6章）在同一个阶段完成：

```typescript
// src/workspace/workspace-initializer.ts

class WorkspaceInitializer {
  constructor(
    private mcpConfigGenerator: McpConfigGenerator,
    private skillDeployer: SkillDeployer,
  ) {}

  /**
   * 初始化用户工作空间
   * 在用户首次创建会话时调用
   */
  async initialize(context: WorkspaceContext): Promise<void> {
    const { workspaceDir } = context;

    // 创建工作空间目录
    mkdirSync(workspaceDir, { recursive: true });

    // 1. 生成 MCP 配置（第6章）
    this.mcpConfigGenerator.generate(context);

    // 2. 部署技能文件（第9章）
    this.skillDeployer.deploy(workspaceDir, context);

    // 3. 初始化记忆文件（第8章）
    await this.initMemoryFiles(context);

    console.log(`[WorkspaceInit] 工作空间已就绪: ${workspaceDir}`);
  }
}
```

---

## 9.6 旧版 SKILL.md 格式迁移指南
### 9.6.1 格式变更对照

对于已有的 SKILL.md 文件，需要按以下规则迁移到 Claude Code Commands 格式：

| 旧格式（SKILL.md） | 新格式（命令 .md） | 说明 |
| --- | --- | --- |
| Frontmatter `name` 字段 | Markdown 一级标题 `# xxx` | 技能名称从 YAML 移入正文 |
| Frontmatter `description` | 正文第一段 | 技能描述从 YAML 移入正文 |
| Frontmatter `slash_command` | 文件名 | `slash_command: "deploy"` → `deploy.md` |
| Frontmatter `parameters` | `$ARGUMENTS` 占位符 + 正文说明 | 参数定义从结构化 YAML 转为自然语言描述 |
| Frontmatter `prerequisites` | 正文 `## 前置条件` 段落 | 前置条件从 YAML 移入正文 |
| Frontmatter `tags` | 子目录分类或正文注释 | 标签信息改为目录结构体现 |
| Body 中 `./scripts/` 路径 | `./.claude/commands/{skill}/scripts/` | 路径前缀变更 |
| Body 中 `./assets/` 路径 | `./.claude/commands/{skill}/assets/` | 路径前缀变更 |

### 9.6.2 迁移脚本
提供一键迁移脚本，将旧版 SKILL.md 格式批量转换为 Claude Code Commands 格式：

```typescript
// scripts/migrate-skills.ts

import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, existsSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';

function migrateSkill(oldSkillDir: string, newCommandsDir: string): void {
  const skillId = basename(oldSkillDir);
  const skillMdPath = join(oldSkillDir, 'SKILL.md');

  if (!existsSync(skillMdPath)) return;

  // 解析旧格式
  const raw = readFileSync(skillMdPath, 'utf-8');
  const { data: frontmatter, content: body } = matter(raw);

  // 构建新格式 Markdown
  const sections: string[] = [];

  // 标题 + 描述
  sections.push(`# ${frontmatter.name || skillId}`);
  if (frontmatter.description) {
    sections.push(frontmatter.description.trim());
  }

  // 参数说明
  if (frontmatter.parameters?.length > 0) {
    sections.push('参数：$ARGUMENTS');
    sections.push('');
    sections.push('支持的参数：');
    for (const p of frontmatter.parameters) {
      const required = p.required ? '（必填）' : `（可选，默认: ${p.default ?? '无'}）`;
      sections.push(`- \`${p.name}\`: ${p.description} ${required}`);
    }
  }

  // 前置条件
  if (frontmatter.prerequisites) {
    sections.push('');
    sections.push('## 前置条件');
    sections.push(frontmatter.prerequisites.trim());
  }

  // 正文
  sections.push('');
  sections.push(body.trim());

  // 替换路径
  let newContent = sections.join('\n');
  newContent = newContent.replace(
    /\.\/scripts\//g,
    `./.claude/commands/${skillId}/scripts/`
  );
  newContent = newContent.replace(
    /\.\/assets\//g,
    `./.claude/commands/${skillId}/assets/`
  );

  // 写入新文件
  const commandName = frontmatter.slash_command || skillId;
  writeFileSync(join(newCommandsDir, `${commandName}.md`), newContent, 'utf-8');

  // 复制资源目录
  const scriptsDir = join(oldSkillDir, 'scripts');
  const assetsDir = join(oldSkillDir, 'assets');

  if (existsSync(scriptsDir) || existsSync(assetsDir)) {
    const resourceDir = join(newCommandsDir, commandName);
    mkdirSync(resourceDir, { recursive: true });
    if (existsSync(scriptsDir)) {
      cpSync(scriptsDir, join(resourceDir, 'scripts'), { recursive: true });
    }
    if (existsSync(assetsDir)) {
      cpSync(assetsDir, join(resourceDir, 'assets'), { recursive: true });
    }
  }

  console.log(`Migrated: ${skillId} → /${commandName}`);
}

// 批量迁移
function migrateAll(oldSkillsRoot: string, newCommandsDir: string): void {
  mkdirSync(newCommandsDir, { recursive: true });

  const entries = readdirSync(oldSkillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    migrateSkill(join(oldSkillsRoot, entry.name), newCommandsDir);
  }
}
```

---

## 9.7 被移除的组件清单
以下组件在新架构中被完全移除，其职责由 Claude Code 原生 Commands 机制承担：

| 被移除组件 | 原有职责 | 替代方案 |
| --- | --- | --- |
| `SkillDiscovery` | 扫描 `skills/` 目录发现技能 | Claude Code 自动扫描 `.claude/commands/` |
| `SkillParser` | 解析 SKILL.md frontmatter (gray-matter) | 无需解析，Claude Code 直接读取 Markdown |
| `SkillRegistry` | 维护 Map 注册表 + 斜杠命令索引 | Claude Code 内置注册表，文件名即命令名 |
| `SkillRouter` | 斜杠命令匹配 + 语义 Embedding 匹配 | Claude Code 原生斜杠命令匹配 |
| `SkillInjector` | 将技能内容构建为 XML 标签注入 System Prompt | Claude Code 原生将命令内容作为 Prompt 注入 |
| `SkillFileWatcher` | fs.watch + 防抖实现热更新 | Claude Code 原生文件变更检测 |
| `SkillLifecycleManager` | 协调发现→解析→注册→热更新全流程 | 无需顶层管理器，Claude Code 全部接管 |

### 语义匹配的取舍说明
旧架构中 `SkillRouter` 支持基于 Embedding 的语义匹配（cosine similarity ≥ 0.78），当用户输入未命中斜杠命令时自动匹配最相关的技能。Claude Code 原生 Commands 不支持语义匹配，仅支持精确的斜杠命令触发。

**设计决策**：接受此取舍。原因如下：
1. **斜杠命令已足够好用**：用户在 Claude Code 中输入 `/` 会看到所有可用命令的列表，可以快速选择；
2. **避免过度匹配**：语义匹配存在误触发风险（阈值 0.78 仍可能产生 false positive），精确匹配更可预期；
3. **简化系统复杂度**：语义匹配需要 Embedding 服务依赖，增加了外部依赖和延迟；
4. **自然语言仍然有效**：即使不通过技能系统匹配，用户直接用自然语言描述需求，Agent 仍能理解并执行——技能系统的价值在于提供标准化的 SOP，而非作为唯一的能力入口。

如果未来确实需要语义触发，可以通过以下轻量方案实现：
- 在 Agent 的 System Prompt 中列出所有可用技能的简要描述；
- Agent 根据用户输入自主决定是否建议使用某个斜杠命令；
- 这将语义匹配的智能从自建系统移交给 Agent 本身。

---

## 9.8 监控与可观测性
在新架构下，技能系统的监控大幅简化，因为运行时管理完全由 Claude Code 负责：

| 指标 | 类型 | 来源 | 说明 |
| --- | --- | --- | --- |
| `skill_deployed_total` | Gauge | SkillDeployer | 已部署到工作空间的技能总数 |
| `skill_deploy_errors` | Counter | SkillDeployer | 技能部署失败次数 |
| `skill_api_operations` | Counter | Skill API | 技能增删查改操作次数 |

> **对比旧架构**：旧方案需要监控 9 个指标（系统状态、注册总数、加载失败、匹配命中、匹配耗时、热更新次数、注入次数等）。新方案仅需 3 个部署相关指标，运行时指标由 Claude Code 自行管理。

健康检查：
```typescript
app.get('/health/skills', (req, res) => {
  const workspaceDir = req.query.workspace as string;
  const commandsDir = join(workspaceDir, '.claude', 'commands');
  const healthy = existsSync(commandsDir);

  const skills = healthy
    ? readdirSync(commandsDir).filter(f => f.endsWith('.md')).length
    : 0;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    deployedSkills: skills,
    commandsDir,
  });
});
```

---

## 9.9 容错与降级策略

| 场景 | 处理策略 |
| --- | --- |
| `.claude/commands/` 目录创建失败 | 记录 ERROR 日志，工作空间初始化失败并重试 |
| 技能源文件不存在 | 记录 WARN 日志，跳过该技能，不影响其他技能的部署 |
| 文件复制失败 | 记录 ERROR 日志，跳过该技能，记录到部署报告 |
| 磁盘空间不足 | 工作空间初始化时预检磁盘空间，不足时拒绝创建 |
| 技能 Markdown 内容无效 | 由 Claude Code 在运行时处理，不影响其他命令 |

---

> **本章小结**：在新架构下，技能系统从"7 个自建组件协作的完整管理体系"简化为"工作空间初始化时的文件部署 + 轻量管理 API"。核心变化在于：技能的发现、注册、匹配、注入、热更新全部由 Claude Code 原生的 Custom Slash Commands 机制承担，YourBot 仅负责在初始化阶段将技能文件部署到 `.claude/commands/` 目录。这一设计消除了约 800 行的自建管理代码（SkillDiscovery、SkillParser、SkillRegistry、SkillRouter、SkillInjector、SkillFileWatcher、SkillLifecycleManager），同时获得了 Claude Code 原生的命令发现、参数解析、热更新等能力。SKILL.md 格式也从 YAML Frontmatter + Markdown Body 简化为纯 Markdown，降低了技能编写的门槛。对于旧方案中的语义匹配能力，通过 Agent System Prompt 列表方式实现轻量替代，避免了外部 Embedding 服务的依赖。
