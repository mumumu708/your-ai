/**
 * MCP Server Registry — single source of truth for built-in MCP server definitions.
 *
 * Used by:
 *   - `McpConfigBuilder` (runtime per-task MCP config passed to AgentBridge)
 *   - `McpConfigGenerator` (workspace-time .mcp.json generation for Claude/Codex CLI)
 *
 * Each entry describes how to launch a server via stdio and what env vars to pass.
 */
import { join } from 'node:path';

export interface McpServerDefinition {
  /** Logical server id (used as key in .mcp.json) */
  id: string;
  /** Launch command (e.g. 'bun') */
  command: string;
  /** Args — note that script paths are resolved via `resolveScriptPath` */
  scriptRelativePath: string;
  /** Additional runtime env — templatable with {{USER_ID}} / {{TENANT_ID}} */
  envTemplate?: Record<string, string>;
  /** Tool-name prefix exposed to the agent (`mcp__<id>__<tool>`) */
  toolNamespace: string;
}

/**
 * Resolve the absolute path for a script given a deployment root.
 * In dev/test this is the repo root; in production it's /opt/yourbot.
 */
export function resolveScriptPath(root: string | undefined, relativePath: string): string {
  const base = root ?? process.env.YOURBOT_ROOT ?? process.cwd();
  return join(base, relativePath);
}

/**
 * Built-in server registry. Each server is launched as a stdio subprocess.
 *
 * Uses a getter to defer env var reads (e.g. SESSION_DB_PATH) so that test
 * code can set them in beforeAll() before the registry values are consumed.
 */
export function getBuiltinMcpServers(): Record<string, McpServerDefinition> {
  return {
    memory: {
      id: 'memory',
      command: process.env.BUN_PATH ?? 'bun',
      scriptRelativePath: 'mcp-servers/memory/index.ts',
      envTemplate: {
        YOURBOT_USER_ID: '{{USER_ID}}',
        OPENVIKING_URL: process.env.OPENVIKING_URL ?? 'http://localhost:1933',
        SESSION_DB_PATH: process.env.SESSION_DB_PATH ?? 'data/session.db',
      },
      toolNamespace: 'memory',
    },
    scheduler: {
      id: 'scheduler',
      command: process.env.BUN_PATH ?? 'bun',
      scriptRelativePath: 'mcp-servers/scheduler/index.ts',
      envTemplate: {
        YOURBOT_USER_ID: '{{USER_ID}}',
        SCHEDULER_DB_URL: '{{SCHEDULER_DB_URL}}',
      },
      toolNamespace: 'scheduler',
    },
    feishu: {
      id: 'feishu',
      command: process.env.BUN_PATH ?? 'bun',
      scriptRelativePath: 'mcp-servers/feishu/index.ts',
      envTemplate: {
        YOURBOT_USER_ID: '{{USER_ID}}',
      },
      toolNamespace: 'feishu',
    },
  };
}

/** @deprecated Use getBuiltinMcpServers() for deferred env reads */
export const BUILTIN_MCP_SERVERS = getBuiltinMcpServers();

/**
 * Tool-level permission patterns for `settings.json`'s `permissions.allow`.
 * Format: `mcp__<namespace>__<toolName>` — `*` wildcard for all tools.
 */
export function buildAllowPatternsForServer(def: McpServerDefinition): string[] {
  return [`mcp__${def.toolNamespace}__*`];
}
