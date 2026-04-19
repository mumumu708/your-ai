import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAllowPatternsForServer,
  getBuiltinMcpServers,
  resolveScriptPath,
} from '../../../mcp-servers/registry';
import { Logger } from '../../shared/logging/logger';

// --- Types ---

export interface McpServerEntry {
  /** stdio type Server */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** SSE/HTTP type Server */
  url?: string;
}

export interface McpJsonConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface TenantConfig {
  thirdPartyServers?: ThirdPartyServerDef[];
  customServers?: CustomServerDef[];
  deniedTools?: string[];
}

export interface ThirdPartyServerDef {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requiredPermissions: string[];
}

export interface CustomServerDef {
  id: string;
  ownerId: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface WorkspaceContext {
  userId: string;
  tenantId: string;
  workspaceDir: string;
  userPermissions: string[];
  tenantConfig: TenantConfig;
}

// --- Generator ---

export class McpConfigGenerator {
  private readonly logger = new Logger('McpConfigGenerator');

  /**
   * Generate complete MCP configuration for a workspace.
   * Called once during workspace initialization.
   */
  generate(context: WorkspaceContext): void {
    this.generateMcpJson(context);
    this.generateClaudeSettings(context);
  }

  /**
   * Generate .mcp.json declaring all available MCP Servers.
   */
  generateMcpJson(context: WorkspaceContext): void {
    const config: McpJsonConfig = { mcpServers: {} };

    const builtinServers = this.getBuiltinServers(context);
    for (const [id, entry] of Object.entries(builtinServers)) {
      config.mcpServers[id] = entry;
    }

    const thirdPartyServers = this.getThirdPartyServers(context);
    for (const [id, entry] of Object.entries(thirdPartyServers)) {
      config.mcpServers[id] = entry;
    }

    const customServers = this.getCustomServers(context);
    for (const [id, entry] of Object.entries(customServers)) {
      config.mcpServers[id] = entry;
    }

    const mcpJsonPath = join(context.workspaceDir, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf-8');
    this.logger.info('.mcp.json 生成', {
      path: mcpJsonPath,
      serverCount: Object.keys(config.mcpServers).length,
    });
  }

  /**
   * Generate .claude/settings.json with permissions and model config.
   */
  generateClaudeSettings(context: WorkspaceContext): void {
    const claudeDir = join(context.workspaceDir, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const settings = {
      permissions: this.buildPermissions(context),
      model: 'claude-sonnet-4-20250514',
    };

    const settingsPath = join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    this.logger.info('Claude settings 生成', { path: settingsPath });
  }

  getBuiltinServers(context: WorkspaceContext): Record<string, McpServerEntry> {
    const servers: Record<string, McpServerEntry> = {};
    const deployRoot = process.env.YOURBOT_ROOT;

    // Memory — always enabled
    const memDef = getBuiltinMcpServers().memory;
    servers[memDef.id] = {
      command: memDef.command,
      args: ['run', resolveScriptPath(deployRoot, memDef.scriptRelativePath)],
      env: this.buildServerEnv(memDef.envTemplate ?? {}, context),
    };

    // Scheduler — always present in workspace config; agent uses it based on task type
    const schedDef = getBuiltinMcpServers().scheduler;
    servers[schedDef.id] = {
      command: schedDef.command,
      args: ['run', resolveScriptPath(deployRoot, schedDef.scriptRelativePath)],
      env: this.buildServerEnv(schedDef.envTemplate ?? {}, context),
    };

    return servers;
  }

  private buildServerEnv(
    template: Record<string, string>,
    context: WorkspaceContext,
  ): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(template)) {
      resolved[key] = value
        .replace('{{USER_ID}}', context.userId)
        .replace('{{TENANT_ID}}', context.tenantId)
        .replace('{{SCHEDULER_DB_URL}}', process.env.SCHEDULER_DB_URL ?? '');
    }
    return resolved;
  }

  getThirdPartyServers(context: WorkspaceContext): Record<string, McpServerEntry> {
    const servers: Record<string, McpServerEntry> = {};

    for (const serverDef of context.tenantConfig.thirdPartyServers ?? []) {
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

  getCustomServers(context: WorkspaceContext): Record<string, McpServerEntry> {
    const servers: Record<string, McpServerEntry> = {};

    for (const serverDef of context.tenantConfig.customServers ?? []) {
      if (serverDef.ownerId !== context.userId) continue;
      servers[serverDef.id] =
        serverDef.transport === 'stdio'
          ? { command: serverDef.command, args: serverDef.args, env: serverDef.env }
          : { url: serverDef.url };
    }

    return servers;
  }

  buildPermissions(context: WorkspaceContext): { allow: string[]; deny: string[] } {
    const allow: string[] = [
      // MCP tool permissions derived from registry
      ...buildAllowPatternsForServer(getBuiltinMcpServers().memory),
      ...buildAllowPatternsForServer(getBuiltinMcpServers().scheduler),
      'Bash(*)',
      'Edit(*)',
      'Write(*)',
      'Read(*)',
    ];

    const deny: string[] = [];

    for (const tool of context.tenantConfig.deniedTools ?? []) {
      deny.push(tool);
    }

    return { allow, deny };
  }

  private checkPermission(requiredPermissions: string[], context: WorkspaceContext): boolean {
    return requiredPermissions.every((perm) => context.userPermissions.includes(perm));
  }

  private resolveEnvVars(
    env: Record<string, string>,
    context: WorkspaceContext,
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
