import {
  type McpServerDefinition,
  getBuiltinMcpServers,
  resolveScriptPath,
} from '../../../mcp-servers/registry';
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
  /** 部署根目录（默认 YOURBOT_ROOT 或 cwd） */
  deployRoot?: string;
}

/**
 * McpConfigBuilder — 根据任务类型和执行模式动态生成 MCP 配置。
 *
 * Server definitions 来自 mcp-servers/registry.ts（与 McpConfigGenerator 同源）。
 *
 * 启用策略：
 * - memory server 始终可用
 * - skill server 仅在非 sync 或 harness 场景启用（暂未在 registry 中，保留 TODO）
 * - scheduler server 仅在 scheduled / automation 场景启用
 * - 用户自定义 server 始终追加
 */
export class McpConfigBuilder {
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor for coverage instrumentation
  constructor() {}

  build(params: McpConfigBuildParams): McpConfig {
    const servers: McpServerConfig[] = [];

    // Memory server 始终可用
    servers.push(this.toServerConfig(getBuiltinMcpServers().memory, params));

    // Scheduler server：定时任务 / 自动化场景
    if (params.taskType === 'scheduled' || params.taskType === 'automation') {
      servers.push(this.toServerConfig(getBuiltinMcpServers().scheduler, params));
    }

    // 用户自定义 servers
    if (params.userMcpServers && params.userMcpServers.length > 0) {
      servers.push(...params.userMcpServers);
    }

    return { mcpServers: servers };
  }

  private toServerConfig(def: McpServerDefinition, params: McpConfigBuildParams): McpServerConfig {
    const scriptPath = resolveScriptPath(params.deployRoot, def.scriptRelativePath);
    const env: Record<string, string> = {};
    for (const [key, tpl] of Object.entries(def.envTemplate ?? {})) {
      env[key] = tpl.replace('{{USER_ID}}', params.userId);
    }
    return {
      name: def.id,
      command: def.command,
      args: ['run', scriptPath],
      env,
    };
  }
}
