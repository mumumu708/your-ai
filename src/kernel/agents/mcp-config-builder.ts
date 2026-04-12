import type { ExecutionMode, McpConfig, McpServerConfig } from './agent-bridge';

/** McpConfigBuilder 的输入参数 */
export interface McpConfigBuildParams {
  /** 执行模式 */
  executionMode: ExecutionMode;
  /** 任务类型 */
  taskType: string;
  /** 用户 ID */
  userId: string;
  /** 用户自定义 MCP 服务器 */
  userMcpServers?: McpServerConfig[];
}

/**
 * McpConfigBuilder — 根据任务类型和执行模式动态生成 MCP 配置。
 *
 * 核心策略：
 * - memory server 始终可用
 * - skill server 仅在非 sync 或 harness 场景启用
 * - scheduler server 仅在 scheduled / automation 场景启用
 * - 用户自定义 server 始终追加
 */
export class McpConfigBuilder {
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor for coverage instrumentation
  constructor() {}

  build(params: McpConfigBuildParams): McpConfig {
    const servers: McpServerConfig[] = [];

    // Memory server 始终可用
    servers.push(this.memoryServer(params.userId));

    // Skill server：非 sync 或 harness 场景
    if (params.executionMode !== 'sync' || params.taskType === 'harness') {
      servers.push(this.skillServer());
    }

    // Scheduler server：定时任务 / 自动化场景
    if (params.taskType === 'scheduled' || params.taskType === 'automation') {
      servers.push(this.schedulerServer());
    }

    // 用户自定义 servers
    if (params.userMcpServers && params.userMcpServers.length > 0) {
      servers.push(...params.userMcpServers);
    }

    return { mcpServers: servers };
  }

  private memoryServer(userId: string): McpServerConfig {
    return {
      name: 'memory',
      command: 'bun',
      args: ['run', 'src/mcp-servers/memory-server/index.ts'],
      env: { USER_ID: userId },
    };
  }

  private skillServer(): McpServerConfig {
    return {
      name: 'skill',
      command: 'bun',
      args: ['run', 'src/mcp-servers/skill-server/index.ts'],
    };
  }

  private schedulerServer(): McpServerConfig {
    return {
      name: 'scheduler',
      command: 'bun',
      args: ['run', 'src/mcp-servers/scheduler-server/index.ts'],
    };
  }
}
