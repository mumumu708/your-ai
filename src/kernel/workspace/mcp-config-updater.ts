import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../../shared/logging/logger';
import type { McpJsonConfig, McpServerEntry } from './mcp-config-generator';

export interface McpConfigUpdaterOptions {
  /** Custom spawn function for testing */
  spawn?: (cmd: string[], cwd: string) => Promise<{ exitCode: number }>;
}

export class McpConfigUpdater {
  private readonly logger = new Logger('McpConfigUpdater');
  private readonly spawn: (cmd: string[], cwd: string) => Promise<{ exitCode: number }>;

  constructor(options: McpConfigUpdaterOptions = {}) {
    this.spawn = options.spawn ?? McpConfigUpdater.defaultSpawn;
  }

  /**
   * Add an MCP Server to an existing workspace via claude mcp add-json.
   */
  async addServer(workspaceDir: string, serverId: string, config: McpServerEntry): Promise<void> {
    const configJson = JSON.stringify(config);
    const result = await this.spawn(
      ['claude', 'mcp', 'add-json', serverId, configJson],
      workspaceDir,
    );

    if (result.exitCode !== 0) {
      this.logger.error('MCP Server 动态注册失败', { serverId, exitCode: result.exitCode });
      throw new Error(`Failed to add MCP server '${serverId}': exit code ${result.exitCode}`);
    }

    this.logger.info('MCP Server 动态注册成功', { serverId });
  }

  /**
   * Remove an MCP Server by rewriting .mcp.json without it.
   */
  removeServer(workspaceDir: string, serverId: string): void {
    const mcpJsonPath = join(workspaceDir, '.mcp.json');
    if (!existsSync(mcpJsonPath)) {
      throw new Error(`.mcp.json not found in ${workspaceDir}`);
    }

    const config: McpJsonConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    if (!config.mcpServers[serverId]) {
      this.logger.info('Server 不存在，无需移除', { serverId });
      return;
    }

    delete config.mcpServers[serverId];
    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf-8');
    this.logger.info('MCP Server 移除', { serverId });
  }

  /**
   * List all servers in the current .mcp.json.
   */
  listServers(workspaceDir: string): Record<string, McpServerEntry> {
    const mcpJsonPath = join(workspaceDir, '.mcp.json');
    if (!existsSync(mcpJsonPath)) {
      return {};
    }
    const config: McpJsonConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    return config.mcpServers;
  }

  private static async defaultSpawn(cmd: string[], cwd: string): Promise<{ exitCode: number }> {
    const proc = Bun.spawn({ cmd, cwd });
    const exitCode = await proc.exited;
    return { exitCode };
  }
}
