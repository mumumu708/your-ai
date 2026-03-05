# 第6章 工具系统（MCP Server）
> **版本变更说明**：本章内容已根据架构优化方案全面重写。YourBot 不再自建 MCP Client 执行层，也不再自建 MCP Server 生命周期管理、配置注入管线，而是**完全托管给 Claude Code 原生机制**。YourBot 的职责收敛为：工作空间初始化时生成 MCP 配置文件、实现内置 MCP Server、高层权限策略控制与可观测性保障。
---

## 6.1 MCP 集成架构变更说明
### 6.1.1 架构演进背景
在第一版架构中，YourBot 自建了完整的 MCP Client 执行层（工具发现、参数校验、执行调度、结果序列化）。第二版将工具执行委托给 Claude CLI，但仍保留了一套重型的 MCP 管理层——包括 `McpServerRegistry`（注册表）、`McpProcessManager`（进程管理器）、`SessionServerOrchestrator`（会话编排器）、`ClaudeSubprocessLauncher`（配置注入+子进程启动器）、`McpConfigMerger`（配置合并器）等组件。

本次优化的核心洞察是：**既然 Claude Code 已被选定为 Agent 执行引擎，就应该完全复用其原生的 MCP 管理能力**，而非在上层重建一套等效的管理基础设施。

Claude Code 原生提供的 MCP 能力包括：
- **配置驱动的 Server 声明**：通过 `.mcp.json`（项目级）和 `.claude/settings.json`（用户级）声明 MCP Server，Claude Code 启动时自动发现并连接；
- **完整的 Server 生命周期管理**：Claude Code 自行负责 stdio 类型 Server 的进程启动、通信管道建立、异常重启；
- **原生工具路由与执行**：`tool_use` → MCP Server 调用 → `tool_result` 全链路由 Claude Code 内部完成；
- **CLI 工具支持**：`claude mcp add-json`、`claude mcp add` 等命令行工具可在运行时动态注册 Server。

因此，YourBot 不再需要维护独立的进程管理器、注册表、配置合并器等组件，将这些职责**完全下沉到 Claude Code**，实现真正的"轻量托管"。

### 6.1.2 三版架构对比

| 维度 | v1：自建 MCP Client | v2：委托执行 + 自建管理 | v3（当前）：完全托管 Claude Code |
| --- | --- | --- | --- |
| 工具发现 | YourBot 连接 Server 调用 `tools/list` | Claude CLI 根据注入配置自动发现 | Claude Code 读取 `.mcp.json` 自动发现 |
| 工具执行 | YourBot 解析 tool_use 自行路由 | Claude CLI 内部完成 | Claude Code 内部完成 |
| Server 进程管理 | YourBot 自建 ProcessManager | YourBot 自建 ProcessManager | **Claude Code 原生管理** |
| 配置注入 | 运行时动态注册 | 生成临时文件 + `--mcp-config` 传入 | **工作空间初始化时写入 `.mcp.json`** |
| 配置合并 | N/A | McpConfigMerger 实现复杂合并 | **无需合并，`.mcp.json` 一次性声明** |
| 会话编排 | SessionServerOrchestrator | SessionServerOrchestrator | **无需编排，配置即声明** |
| YourBot 代码量 | ~2000 行 | ~1200 行 | **~200 行（仅配置生成）** |
| YourBot 职责 | 全链路 | 管理层 + 监控 | **配置生成 + 内置 Server 实现 + 监控** |

### 6.1.3 新架构总体视图
```plaintext
┌─────────────────────────────────────────────────────┐
│                   YourBot Platform                   │
│                                                      │
│  ┌──────────────────┐  ┌───────────────────────────┐ │
│  │ Workspace Init   │  │    可观测性               │ │
│  │ (配置生成器)      │  │  (stream-json 解析 +     │ │
│  │                  │  │   Server 侧日志采集)      │ │
│  │ 生成:            │  │                           │ │
│  │ • .mcp.json      │  │                           │ │
│  │ • settings.json  │  │                           │ │
│  └────────┬─────────┘  └─────────────┬─────────────┘ │
│           │                          │               │
│           ▼                          ▼               │
│  ┌─────────────────────────────────────────────────┐ │
│  │      Claude Code（原生 MCP 管理 + 执行引擎）     │ │
│  │                                                  │ │
│  │  读取 .mcp.json → 自动启动 Server 进程            │ │
│  │  → 建立通信管道 → tool_use 路由 → tool_result     │ │
│  │  → 异常重启 → 优雅关闭                            │ │
│  └──────┬──────────────┬──────────────┬─────────────┘ │
└─────────┼──────────────┼──────────────┼───────────────┘
          │              │              │
          ▼              ▼              ▼
  ┌──────────────┐ ┌──────────┐ ┌──────────────┐
  │ YourBot 内置  │ │ 第三方    │ │ 用户自定义   │
  │ MCP Server   │ │ MCP      │ │ MCP Server   │
  │ (飞书/记忆/   │ │ Server   │ │              │
  │  定时任务)    │ │          │ │              │
  └──────────────┘ └──────────┘ └──────────────┘
```

### 6.1.4 核心设计原则
1. **完全托管原则**：MCP Server 的进程启动、通信、健康检查、异常恢复全部由 Claude Code 负责，YourBot 不介入任何运行时管理；
2. **配置即声明**：YourBot 通过在工作空间初始化时生成 `.mcp.json` 和 `.claude/settings.json` 来声明可用的 MCP Server 集合，取代运行时动态注册；
3. **权限前置**：权限控制在配置生成阶段完成——未写入配置文件的 Server，Claude Code 无从得知，从而实现"不可见即不可用"；
4. **可观测性保障**：虽然运行时管理完全托管，YourBot 通过 Claude Code 的 stream-json 输出和 Server 侧埋点保持工具调用的完整可观测性。
---

## 6.2 MCP 配置生成机制
### 6.2.1 Claude Code 原生配置体系
Claude Code 支持两层 MCP 配置，YourBot 在工作空间初始化时按需生成：

| 配置文件 | 路径 | 作用域 | YourBot 用途 |
| --- | --- | --- | --- |
| `.mcp.json` | 工作空间根目录 | 项目级，该目录下所有 Claude Code 会话共享 | 声明所有 MCP Server（内置 + 第三方 + 用户自定义） |
| `.claude/settings.json` | 工作空间根目录下 `.claude/` | 用户级 Claude Code 设置 | 声明工具权限（`permissions.allow` / `permissions.deny`）、可选额外 MCP Server |

### 6.2.2 工作空间初始化时的配置生成
每个用户的工作空间在首次创建时，由 `WorkspaceInitializer` 一次性生成 MCP 配置文件。后续会话复用已有配置，无需每次启动都重新生成。

```typescript
// src/workspace/mcp-config-generator.ts

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

interface McpServerEntry {
  /** stdio 类型 Server */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** SSE/HTTP 类型 Server */
  url?: string;
}

interface McpJsonConfig {
  mcpServers: Record<string, McpServerEntry>;
}

interface WorkspaceContext {
  userId: string;
  tenantId: string;
  workspaceDir: string;       // e.g. /data/workspaces/{userId}/{sessionId}
  userPermissions: string[];  // 用户拥有的权限列表
  tenantConfig: TenantConfig; // 租户级配置（允许的 Server 列表、自定义 Server 等）
}

class McpConfigGenerator {
  /**
   * 在工作空间初始化时生成完整的 MCP 配置
   * 此方法仅在工作空间首次创建时调用一次
   */
  generate(context: WorkspaceContext): void {
    this.generateMcpJson(context);
    this.generateClaudeSettings(context);
  }

  /**
   * 生成 .mcp.json — 声明所有可用的 MCP Server
   */
  private generateMcpJson(context: WorkspaceContext): void {
    const config: McpJsonConfig = {
      mcpServers: {},
    };

    // 1. 添加内置 MCP Server（根据权限过滤）
    const builtinServers = this.getBuiltinServers(context);
    for (const [id, entry] of Object.entries(builtinServers)) {
      config.mcpServers[id] = entry;
    }

    // 2. 添加租户配置的第三方 MCP Server
    const thirdPartyServers = this.getThirdPartyServers(context);
    for (const [id, entry] of Object.entries(thirdPartyServers)) {
      config.mcpServers[id] = entry;
    }

    // 3. 添加用户自定义 MCP Server
    const customServers = this.getCustomServers(context);
    for (const [id, entry] of Object.entries(customServers)) {
      config.mcpServers[id] = entry;
    }

    // 写入 .mcp.json
    const mcpJsonPath = join(context.workspaceDir, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * 生成 .claude/settings.json — 声明工具权限和额外设置
   */
  private generateClaudeSettings(context: WorkspaceContext): void {
    const claudeDir = join(context.workspaceDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: this.buildPermissions(context),
      // Claude Code 原生设置
      model: 'claude-sonnet-4-20250514',
    };

    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  /**
   * 获取内置 MCP Server 配置（根据用户权限过滤）
   */
  private getBuiltinServers(
    context: WorkspaceContext
  ): Record<string, McpServerEntry> {
    const servers: Record<string, McpServerEntry> = {};

    // 飞书 Server — 所有用户可用
    servers['feishu-server'] = {
      command: 'bun',
      args: ['run', '/opt/yourbot/mcp-servers/feishu/index.ts'],
      env: {
        FEISHU_APP_ID: process.env.FEISHU_APP_ID!,
        FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET!,
        YOURBOT_USER_ID: context.userId,
        YOURBOT_TENANT_ID: context.tenantId,
      },
    };

    // 记忆 Server — 所有用户可用
    servers['memory-server'] = {
      command: 'bun',
      args: ['run', '/opt/yourbot/mcp-servers/memory/index.ts'],
      env: {
        MEMORY_STORE_PATH: `/data/yourbot/memory/${context.userId}`,
        YOURBOT_USER_ID: context.userId,
      },
    };

    // 定时任务 Server — 所有用户可用
    servers['scheduler-server'] = {
      command: 'bun',
      args: ['run', '/opt/yourbot/mcp-servers/scheduler/index.ts'],
      env: {
        SCHEDULER_DB_URL: process.env.SCHEDULER_DB_URL!,
        YOURBOT_USER_ID: context.userId,
      },
    };

    return servers;
  }

  /**
   * 获取租户配置的第三方 Server
   */
  private getThirdPartyServers(
    context: WorkspaceContext
  ): Record<string, McpServerEntry> {
    const servers: Record<string, McpServerEntry> = {};

    for (const serverDef of context.tenantConfig.thirdPartyServers ?? []) {
      // 检查用户是否有权限使用此 Server
      if (!this.checkPermission(serverDef.requiredPermissions, context)) {
        continue;
      }

      servers[serverDef.id] = {
        command: serverDef.command,
        args: serverDef.args,
        env: this.resolveEnvVars(serverDef.env ?? {}, context),
      };
    }

    return servers;
  }

  /**
   * 获取用户自定义 Server
   */
  private getCustomServers(
    context: WorkspaceContext
  ): Record<string, McpServerEntry> {
    const servers: Record<string, McpServerEntry> = {};

    for (const serverDef of context.tenantConfig.customServers ?? []) {
      if (serverDef.ownerId !== context.userId) continue;

      servers[serverDef.id] = serverDef.transport === 'stdio'
        ? { command: serverDef.command!, args: serverDef.args, env: serverDef.env }
        : { url: serverDef.url! };
    }

    return servers;
  }

  /**
   * 构建权限声明
   */
  private buildPermissions(
    context: WorkspaceContext
  ): { allow: string[]; deny: string[] } {
    const allow: string[] = [];
    const deny: string[] = [];

    // 允许所有已配置 Server 的工具
    // （未写入 .mcp.json 的 Server 天然不可见，无需 deny）
    allow.push('mcp__feishu_server__*');
    allow.push('mcp__memory_server__*');
    allow.push('mcp__scheduler_server__*');

    // 允许 Claude Code 内置工具
    allow.push('Bash(*)');
    allow.push('Edit(*)');
    allow.push('Write(*)');
    allow.push('Read(*)');

    // 租户级工具拒绝规则
    for (const tool of context.tenantConfig.deniedTools ?? []) {
      deny.push(tool);
    }

    return { allow, deny };
  }

  private checkPermission(
    requiredPermissions: string[],
    context: WorkspaceContext
  ): boolean {
    return requiredPermissions.every(perm =>
      context.userPermissions.includes(perm)
    );
  }

  private resolveEnvVars(
    env: Record<string, string>,
    context: WorkspaceContext
  ): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      resolved[key] = value
        .replace('{{USER_ID}}', context.userId)
        .replace('{{TENANT_ID}}', context.tenantId);
    }
    return resolved;
  }
}
```

### 6.2.3 生成的配置文件示例
**`.mcp.json`（工作空间根目录）**：
```json
{
  "mcpServers": {
    "feishu-server": {
      "command": "bun",
      "args": ["run", "/opt/yourbot/mcp-servers/feishu/index.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxxxx",
        "FEISHU_APP_SECRET": "xxxxx",
        "YOURBOT_USER_ID": "user_12345",
        "YOURBOT_TENANT_ID": "tenant_001"
      }
    },
    "memory-server": {
      "command": "bun",
      "args": ["run", "/opt/yourbot/mcp-servers/memory/index.ts"],
      "env": {
        "MEMORY_STORE_PATH": "/data/yourbot/memory/user_12345",
        "YOURBOT_USER_ID": "user_12345"
      }
    },
    "scheduler-server": {
      "command": "bun",
      "args": ["run", "/opt/yourbot/mcp-servers/scheduler/index.ts"],
      "env": {
        "SCHEDULER_DB_URL": "sqlite:///data/yourbot/scheduler.db",
        "YOURBOT_USER_ID": "user_12345"
      }
    }
  }
}
```

**`.claude/settings.json`**：
```json
{
  "permissions": {
    "allow": [
      "mcp__feishu_server__*",
      "mcp__memory_server__*",
      "mcp__scheduler_server__*",
      "Bash(*)",
      "Edit(*)",
      "Write(*)",
      "Read(*)"
    ],
    "deny": []
  },
  "model": "claude-sonnet-4-20250514"
}
```

### 6.2.4 配置更新策略
当需要动态更新 MCP Server 配置时（如管理员添加新的第三方 Server），有两种策略：

| 场景 | 策略 | 实现方式 |
| --- | --- | --- |
| 新会话自动获取最新配置 | **配置模板更新** | 更新配置模板，新建工作空间自动使用最新配置 |
| 现有工作空间添加 Server | **CLI 命令注入** | 通过 `claude mcp add-json` 命令动态注册 |
| 移除 Server | **重新生成配置** | 重新生成 `.mcp.json` 并重启 Claude Code 会话 |

```typescript
// src/workspace/mcp-config-updater.ts

class McpConfigUpdater {
  /**
   * 为现有工作空间动态添加 MCP Server
   * 利用 Claude Code 的 CLI 命令实现运行时注入
   */
  async addServer(
    workspaceDir: string,
    serverId: string,
    config: McpServerEntry
  ): Promise<void> {
    const configJson = JSON.stringify({
      command: config.command,
      args: config.args,
      env: config.env,
    });

    // 使用 claude mcp add-json 动态注册
    const proc = Bun.spawn({
      cmd: ['claude', 'mcp', 'add-json', serverId, configJson],
      cwd: workspaceDir,
    });
    await proc.exited;
  }
}
```

### 6.2.5 与 ClaudeAgentBridge 的集成
在第4章的 `ClaudeAgentBridge` 中，工作空间已设置好 `.mcp.json` 和 `.claude/settings.json`，因此 Agent SDK 调用时只需指定工作目录，Claude Code 会自动加载配置：

```typescript
// src/agent/claude-agent-bridge.ts（简化后）

class ClaudeAgentBridge {
  async executeTask(params: AgentTaskParams): Promise<AgentResult> {
    const options: ClaudeAgentOptions = {
      model: params.model || 'claude-sonnet-4-20250514',
      maxTurns: params.maxTurns || 30,
      // 关键：指定工作目录，Claude Code 自动读取 .mcp.json
      cwd: params.workingDirectory,
      // 内置 YourBot MCP Server（通过 Agent SDK inline 方式挂载）
      mcpServers: {
        'yourbot-internal': this.createInternalMcpServer(params),
      },
      // Claude Code 从 .claude/settings.json 加载 permissions
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      appendSystemPrompt: this.buildSystemContext(params.userId),
    };

    return await query(options);
  }
}
```

> **关键变化**：不再需要 `SessionServerOrchestrator.prepareForSession()`、`ClaudeSubprocessLauncher.launch()`、`McpConfigMerger.merge()` 等多层编排。工作空间的 `.mcp.json` 在初始化时已就绪，Claude Code 启动时自动读取，整个启动链路从 ~5 个组件协作简化为 1 个配置文件。

---

## 6.3 YourBot 内置 MCP Server
### 6.3.1 内置 Server 概览
YourBot 将自身的平台能力封装为标准 MCP Server，通过 stdio 传输暴露给 Claude Code。每个内置 Server 都是独立的 Bun 脚本，在 Claude Code 读取 `.mcp.json` 后自动作为子进程启动。

| Server ID | 提供的核心工具 | 说明 |
| --- | --- | --- |
| `feishu-server` | `feishu_send_message`, `feishu_read_doc`, `feishu_create_doc`, `feishu_search`, `feishu_get_calendar` | 飞书平台操作：消息发送、文档读写、搜索、日历查询 |
| `memory-server` | `memory_store`, `memory_retrieve`, `memory_search`, `memory_delete` | 用户记忆系统：长期记忆的存取与语义检索 |
| `scheduler-server` | `schedule_create`, `schedule_list`, `schedule_cancel`, `schedule_update` | 定时任务管理：创建、查询、取消定时触发的任务 |
| `web-search-server` | `web_search`, `web_fetch`, `web_summarize` | 网络搜索与内容获取 |

> **注意**：Server 进程的启动、通信管道建立、异常重启等生命周期管理完全由 Claude Code 负责。YourBot 仅负责实现 Server 本身的工具逻辑。

### 6.3.2 飞书 MCP Server 实现示例
```typescript
// mcp-servers/feishu/index.ts

import { McpServer } from '@anthropic-ai/sdk/mcp';
import { z } from 'zod';
import { FeishuClient } from './feishu-client';

const server = new McpServer({
  name: 'feishu-server',
  version: '1.0.0',
  description: 'YourBot 飞书集成工具集',
});

const feishuClient = new FeishuClient({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

// 发送飞书消息
server.tool(
  'feishu_send_message',
  '向指定的飞书用户或群组发送消息',
  {
    target: z.string().describe('目标用户 open_id 或群组 chat_id'),
    targetType: z.enum(['user', 'group']).describe('目标类型'),
    messageType: z.enum(['text', 'interactive', 'markdown'])
      .default('text')
      .describe('消息类型'),
    content: z.string().describe('消息内容'),
  },
  async ({ target, targetType, messageType, content }) => {
    try {
      const receiveIdType = targetType === 'user' ? 'open_id' : 'chat_id';
      const result = await feishuClient.sendMessage({
        receive_id: target,
        receive_id_type: receiveIdType,
        msg_type: messageType,
        content: formatContent(messageType, content),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              messageId: result.message_id,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// 读取飞书文档
server.tool(
  'feishu_read_doc',
  '读取飞书云文档的内容',
  {
    docToken: z.string().describe('文档 token（从 URL 中提取）'),
    docType: z.enum(['docx', 'wiki', 'sheet']).default('docx')
      .describe('文档类型'),
  },
  async ({ docToken, docType }) => {
    try {
      const content = await feishuClient.getDocContent(docToken, docType);
      return {
        content: [
          {
            type: 'text' as const,
            text: content,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `读取文档失败: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// 启动 Server（stdio 传输）
server.run({ transport: 'stdio' });

function formatContent(type: string, content: string): string {
  switch (type) {
    case 'text':
      return JSON.stringify({ text: content });
    case 'markdown':
      return JSON.stringify({ zh_cn: { content } });
    default:
      return content;
  }
}
```

### 6.3.3 记忆系统 MCP Server
```typescript
// mcp-servers/memory/index.ts

import { McpServer } from '@anthropic-ai/sdk/mcp';
import { z } from 'zod';
import { VectorStore } from './vector-store';

const server = new McpServer({
  name: 'memory-server',
  version: '1.0.0',
  description: 'YourBot 用户记忆存取系统',
});

const store = new VectorStore({
  storagePath: process.env.MEMORY_STORE_PATH!,
  userId: process.env.YOURBOT_USER_ID!,
});

// 存储记忆
server.tool(
  'memory_store',
  '将重要信息存储到用户的长期记忆中，以便在后续对话中检索使用',
  {
    content: z.string().describe('要存储的记忆内容'),
    category: z.enum(['preference', 'fact', 'context', 'instruction'])
      .describe('记忆分类：偏好/事实/上下文/指令'),
    tags: z.array(z.string()).optional()
      .describe('用于组织和检索的标签'),
    importance: z.enum(['low', 'medium', 'high']).default('medium')
      .describe('重要性级别'),
  },
  async ({ content, category, tags, importance }) => {
    const id = await store.insert({
      content,
      category,
      tags: tags ?? [],
      importance,
      timestamp: Date.now(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, memoryId: id }),
        },
      ],
    };
  }
);

// 语义检索记忆
server.tool(
  'memory_search',
  '通过语义相似度搜索用户的历史记忆',
  {
    query: z.string().describe('搜索查询文本'),
    category: z.enum(['preference', 'fact', 'context', 'instruction'])
      .optional()
      .describe('限定搜索的记忆分类'),
    limit: z.number().min(1).max(20).default(5)
      .describe('返回结果数量上限'),
  },
  async ({ query, category, limit }) => {
    const results = await store.search(query, { category, limit });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            results: results.map(r => ({
              id: r.id,
              content: r.content,
              category: r.category,
              tags: r.tags,
              similarity: r.score,
              createdAt: r.timestamp,
            })),
          }),
        },
      ],
    };
  }
);

server.run({ transport: 'stdio' });
```

### 6.3.4 定时任务 MCP Server
```typescript
// mcp-servers/scheduler/index.ts

import { McpServer } from '@anthropic-ai/sdk/mcp';
import { z } from 'zod';
import { SchedulerClient } from './scheduler-client';

const server = new McpServer({
  name: 'scheduler-server',
  version: '1.0.0',
  description: 'YourBot 定时任务管理',
});

const scheduler = new SchedulerClient({
  dbUrl: process.env.SCHEDULER_DB_URL!,
  userId: process.env.YOURBOT_USER_ID!,
});

server.tool(
  'schedule_create',
  '创建一个定时任务，到达指定时间后自动触发执行',
  {
    name: z.string().describe('任务名称'),
    description: z.string().describe('任务描述，说明到时要做什么'),
    triggerAt: z.string().describe('触发时间，ISO 8601 格式'),
    recurring: z.object({
      enabled: z.boolean(),
      cron: z.string().optional().describe('cron 表达式（recurring 时必填）'),
    }).optional().describe('循环配置'),
    action: z.object({
      type: z.enum(['send_message', 'run_prompt']),
      payload: z.record(z.unknown()).describe('动作参数'),
    }).describe('触发时执行的动作'),
  },
  async ({ name, description, triggerAt, recurring, action }) => {
    const task = await scheduler.createTask({
      name,
      description,
      triggerAt: new Date(triggerAt),
      recurring,
      action,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            taskId: task.id,
            nextTrigger: task.nextTriggerAt,
          }),
        },
      ],
    };
  }
);

server.run({ transport: 'stdio' });
```

---

## 6.4 工具权限与安全控制
### 6.4.1 权限控制模型
在完全托管架构下，权限控制从"运行时拦截"转变为"配置生成时过滤"，形成两层防御：

```plaintext
┌────────────────────────────────────────────┐
│    第一层：配置生成级控制（YourBot 侧）       │
│  → McpConfigGenerator 决定哪些 Server        │
│    写入 .mcp.json                           │
│  → 未写入的 Server，Claude Code 无从得知      │
│  → 同时生成 permissions allow/deny 列表      │
├────────────────────────────────────────────┤
│    第二层：Server 内部鉴权                    │
│  → 每个 MCP Server 内部校验请求的合法性       │
│  → 基于环境变量传入的 userId/tenantId         │
│  → 高风险操作触发审批拦截                     │
└────────────────────────────────────────────┘
```

> **对比旧架构**：v2 版本有三层控制（注入级 + 声明级 + Server 内部鉴权），其中前两层实质是同一件事的两种表达。v3 将其合并为"配置生成级控制"，在 `.mcp.json` 和 `.claude/settings.json` 生成时一次性完成，更简洁且无歧义。

### 6.4.2 Server 内部鉴权
每个内置 MCP Server 通过环境变量接收调用者身份信息，并在工具处理函数内部进行鉴权：
```typescript
// mcp-servers/shared/auth-middleware.ts

interface AuthContext {
  userId: string;
  tenantId: string;
}

function createAuthMiddleware() {
  const authContext: AuthContext = {
    userId: process.env.YOURBOT_USER_ID ?? '',
    tenantId: process.env.YOURBOT_TENANT_ID ?? '',
  };

  if (!authContext.userId) {
    throw new Error('YOURBOT_USER_ID environment variable is required');
  }

  return {
    getContext: () => authContext,

    /**
     * 校验当前请求是否有权访问指定资源
     */
    assertAccess(resourceOwnerId: string): void {
      if (resourceOwnerId !== authContext.userId) {
        throw new Error(
          `Access denied: user ${authContext.userId} ` +
          `cannot access resource owned by ${resourceOwnerId}`
        );
      }
    },
  };
}
```

### 6.4.3 敏感操作审批机制
对于高风险工具操作（如删除文档、批量发送消息），YourBot 在 Server 内部实现审批拦截：
```typescript
// mcp-servers/feishu/approval-gate.ts

const SENSITIVE_OPERATIONS = new Set([
  'feishu_delete_doc',
  'feishu_batch_send_message',
  'feishu_update_permissions',
]);

async function checkApproval(
  toolName: string,
  userId: string,
  params: Record<string, unknown>
): Promise<{ approved: boolean; reason?: string }> {
  if (!SENSITIVE_OPERATIONS.has(toolName)) {
    return { approved: true };
  }

  // 查询是否存在预先审批记录
  const approval = await getApprovalRecord(userId, toolName, params);
  if (approval?.status === 'approved') {
    return { approved: true };
  }

  // 需要审批，返回拒绝并附带审批请求指引
  return {
    approved: false,
    reason: `操作 '${toolName}' 需要额外审批。` +
      `请在 YourBot 管理面板中确认此操作后重试。`,
  };
}
```

---

## 6.5 工具监控与日志
### 6.5.1 监控体系概述
虽然 Server 进程管理完全托管给 Claude Code，YourBot 仍需保持对工具调用的完整可观测性。在 v3 架构下，监控数据来源简化为两个通道：

| 数据来源 | 采集方式 | 包含信息 |
| --- | --- | --- |
| **Claude Code 流式输出** | 解析 `stream-json` 中的 `tool_use` / `tool_result` 事件 | 工具名称、参数、执行结果、耗时 |
| **MCP Server 侧日志** | 各 Server 内部埋点，写入结构化日志 | 详细执行过程、错误堆栈、资源访问记录 |

> **对比旧架构**：v2 版本还有第三个通道"进程管理器指标"（ProcessManager 采集 Server 进程状态）。在 v3 中，进程管理由 Claude Code 负责，YourBot 不再直接接触 Server 进程，因此该通道被移除。Server 的运行状态可通过 Claude Code 的 stream-json 输出间接观测（如工具调用超时、Server 无响应等）。

### 6.5.2 Claude Code 输出解析与监控
```typescript
// src/monitoring/tool-call-monitor.ts

interface ToolCallEvent {
  sessionId: string;
  toolName: string;
  serverId: string;
  input: Record<string, unknown>;
  output?: string;
  startTime: number;
  endTime?: number;
  status: 'started' | 'success' | 'error';
  errorMessage?: string;
}

class ToolCallMonitor {
  private activeToolCalls = new Map<string, ToolCallEvent>();

  /**
   * 从 Claude Code 的 stream-json 输出中提取工具调用事件
   */
  processStreamEvent(
    sessionId: string,
    event: ClaudeStreamEvent
  ): void {
    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') {
        const toolCall: ToolCallEvent = {
          sessionId,
          toolName: event.content_block.name,
          serverId: this.extractServerId(event.content_block.name),
          input: {},
          startTime: Date.now(),
          status: 'started',
        };
        this.activeToolCalls.set(event.content_block.id, toolCall);

        metrics.increment('tool_call.started', {
          tool: toolCall.toolName,
          server: toolCall.serverId,
        });
      }
    }

    if (event.type === 'content_block_stop') {
      const toolCall = this.activeToolCalls.get(event.id);
      if (toolCall) {
        toolCall.endTime = Date.now();
        toolCall.status = 'success';
        const duration = toolCall.endTime - toolCall.startTime;

        metrics.histogram('tool_call.duration_ms', duration, {
          tool: toolCall.toolName,
          server: toolCall.serverId,
        });
        metrics.increment('tool_call.completed', {
          tool: toolCall.toolName,
          status: toolCall.status,
        });

        // 持久化工具调用记录
        this.persistToolCallLog(toolCall);
        this.activeToolCalls.delete(event.id);
      }
    }

    if (event.type === 'tool_result' && event.is_error) {
      const toolCall = this.findToolCallByContext(event);
      if (toolCall) {
        toolCall.status = 'error';
        toolCall.errorMessage = event.content;

        metrics.increment('tool_call.error', {
          tool: toolCall.toolName,
          server: toolCall.serverId,
        });
      }
    }
  }

  /**
   * 从工具名称中提取 Server ID
   * Claude MCP 工具名称格式: mcp__{serverId}__{toolName}
   */
  private extractServerId(fullToolName: string): string {
    const match = fullToolName.match(/^mcp__(.+?)__(.+)$/);
    return match ? match[1] : 'unknown';
  }

  private async persistToolCallLog(event: ToolCallEvent): Promise<void> {
    await db.toolCallLogs.insert({
      sessionId: event.sessionId,
      toolName: event.toolName,
      serverId: event.serverId,
      input: JSON.stringify(event.input),
      output: event.output ?? null,
      startTime: new Date(event.startTime),
      endTime: event.endTime ? new Date(event.endTime) : null,
      durationMs: event.endTime ? event.endTime - event.startTime : null,
      status: event.status,
      errorMessage: event.errorMessage ?? null,
    });
  }

  private findToolCallByContext(event: any): ToolCallEvent | undefined {
    return Array.from(this.activeToolCalls.values()).find(
      tc => tc.status === 'started'
    );
  }
}
```

### 6.5.3 MCP Server 侧结构化日志
每个内置 MCP Server 内部集成统一的日志模块：
```typescript
// mcp-servers/shared/logger.ts

import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';

interface ToolExecutionLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  serverId: string;
  toolName: string;
  userId: string;
  traceId: string;
  durationMs: number;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

class McpServerLogger {
  private logStream: ReturnType<typeof createWriteStream>;

  constructor(serverId: string) {
    const logDir = process.env.LOG_DIR ?? '/var/log/yourbot/mcp-servers';
    mkdirSync(logDir, { recursive: true });
    this.logStream = createWriteStream(
      join(logDir, `${serverId}.jsonl`),
      { flags: 'a' }
    );
  }

  logToolExecution(log: ToolExecutionLog): void {
    const line = JSON.stringify(log) + '\n';
    this.logStream.write(line);

    // 错误级别同时输出到 stderr
    if (log.level === 'error') {
      console.error(
        `[${log.serverId}] Tool '${log.toolName}' error: ${log.error}`
      );
    }
  }
}

/**
 * 工具执行包装器，自动记录日志
 */
function withLogging<T extends (...args: any[]) => Promise<any>>(
  logger: McpServerLogger,
  serverId: string,
  toolName: string,
  handler: T
): T {
  return (async (...args: any[]) => {
    const startTime = Date.now();
    const userId = process.env.YOURBOT_USER_ID ?? 'unknown';
    const traceId = generateTraceId();

    try {
      const result = await handler(...args);
      logger.logToolExecution({
        timestamp: new Date().toISOString(),
        level: 'info',
        serverId,
        toolName,
        userId,
        traceId,
        durationMs: Date.now() - startTime,
        input: args[0] ?? {},
        output: result,
      });
      return result;
    } catch (error) {
      logger.logToolExecution({
        timestamp: new Date().toISOString(),
        level: 'error',
        serverId,
        toolName,
        userId,
        traceId,
        durationMs: Date.now() - startTime,
        input: args[0] ?? {},
        error: String(error),
      });
      throw error;
    }
  }) as T;
}

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}
```

### 6.5.4 告警规则
在 v3 架构下，告警规则基于 Server 侧日志和 Claude Code 输出，不再依赖 ProcessManager 的进程状态：
```typescript
// src/monitoring/alert-rules.ts

const ALERT_RULES = [
  {
    name: 'mcp_tool_high_error_rate',
    description: '工具调用错误率超过阈值',
    condition: (stats: ToolCallStats) => {
      return stats.total > 10 && stats.errorRate > 0.3;
    },
    severity: 'warning' as const,
    action: 'notify',
  },
  {
    name: 'mcp_tool_high_latency',
    description: '工具调用平均延迟超过阈值',
    condition: (stats: ToolCallStats) =>
      stats.avgDurationMs > 10_000,
    severity: 'warning' as const,
    action: 'notify',
  },
  {
    name: 'mcp_server_unreachable',
    description: 'MCP Server 持续无响应（通过 tool_result 错误检测）',
    condition: (stats: ToolCallStats) =>
      stats.consecutiveErrors > 5,
    severity: 'critical' as const,
    action: 'notify_and_log',
  },
];
```

### 6.5.5 审计日志
所有工具调用记录保留完整的审计轨迹，用于安全审查和问题排查：
```typescript
// src/monitoring/audit-log.ts

interface AuditLogEntry {
  timestamp: string;
  eventType: 'tool_call' | 'config_generated' | 'permission_denied' | 'approval_required';
  sessionId: string;
  userId: string;
  tenantId: string;
  serverId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: 'success' | 'error' | 'denied';
  details?: string;
}

class AuditLogger {
  async log(entry: AuditLogEntry): Promise<void> {
    await auditStore.append({
      ...entry,
      input: entry.input ? this.redactSensitiveFields(entry.input) : undefined,
    });
  }

  private redactSensitiveFields(
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const sensitiveKeys = ['password', 'token', 'secret', 'api_key', 'credential'];
    const redacted = { ...input };

    for (const key of Object.keys(redacted)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        redacted[key] = '[REDACTED]';
      }
    }
    return redacted;
  }
}
```

---

## 6.6 被移除的组件清单
以下组件在 v3 架构中被完全移除，其职责由 Claude Code 原生机制承担：

| 被移除组件 | 原有职责 | 替代方案 |
| --- | --- | --- |
| `McpServerRegistry` | MCP Server 元信息注册与查询 | `.mcp.json` 文件即是注册表 |
| `McpProcessManager` | Server 子进程启动/停止/健康检查/重启 | Claude Code 原生管理 stdio Server 进程 |
| `SessionServerOrchestrator` | 按会话编排 Server 集合 | 工作空间初始化时一次性生成 `.mcp.json`，无需会话级编排 |
| `ClaudeSubprocessLauncher` | 生成临时配置 + 通过 `--mcp-config` 启动 | Claude Code 自动读取 `.mcp.json`，无需临时配置 |
| `McpConfigMerger` | 全局配置 + 会话配置合并 | 单一 `.mcp.json` 包含全部 Server，无需合并 |
| `ToolPermissionGate` | 运行时权限过滤 | `McpConfigGenerator` 在生成配置时完成过滤 |
| `ClaudePermissionsBuilder` | 生成 permissions 配置 | 合并进 `McpConfigGenerator.buildPermissions()` |
| `ServerHealthReporter` | Server 健康状态仪表盘 | 通过 Server 侧日志 + Claude Code 输出间接监控 |

---

> **本章小结**：在 v3 架构下，YourBot 的工具系统从"委托执行 + 自建管理"进一步简化为"完全托管"模式。核心变化在于：MCP Server 的生命周期管理、进程控制、配置注入全部由 Claude Code 原生机制承担，YourBot 仅在工作空间初始化时生成 `.mcp.json` 和 `.claude/settings.json` 配置文件。这一设计消除了约 1000 行的管理层代码（McpServerRegistry、McpProcessManager、SessionServerOrchestrator、ClaudeSubprocessLauncher、McpConfigMerger 等），将工具系统的 YourBot 侧代码量从约 1200 行减少到约 200 行，同时获得了 Claude Code 经过大规模验证的进程管理稳定性。YourBot 自身的平台能力（飞书操作、记忆系统、定时任务）仍以标准 MCP Server 形式实现，权限控制在配置生成阶段完成，可观测性通过 stream-json 解析和 Server 侧日志保持完整。
