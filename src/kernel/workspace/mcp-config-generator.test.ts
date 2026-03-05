import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  McpConfigGenerator,
  type McpJsonConfig,
  type WorkspaceContext,
} from './mcp-config-generator';

const TEST_DIR = join(import.meta.dir, '__test_mcp_config__');

function createContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    userId: 'user_001',
    tenantId: 'tenant_001',
    workspaceDir: TEST_DIR,
    userPermissions: [],
    tenantConfig: {},
    ...overrides,
  };
}

describe('McpConfigGenerator', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('generate', () => {
    test('应该同时生成 .mcp.json 和 .claude/settings.json', () => {
      const generator = new McpConfigGenerator();
      const context = createContext();
      generator.generate(context);

      expect(existsSync(join(TEST_DIR, '.mcp.json'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.claude', 'settings.json'))).toBe(true);
    });
  });

  describe('generateMcpJson', () => {
    test('应该生成包含3个内置 Server 的 .mcp.json', () => {
      const generator = new McpConfigGenerator();
      const context = createContext();
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(Object.keys(mcpJson.mcpServers)).toContain('feishu-server');
      expect(Object.keys(mcpJson.mcpServers)).toContain('memory-server');
      expect(Object.keys(mcpJson.mcpServers)).toContain('scheduler-server');
    });

    test('内置 Server 应该包含 userId 环境变量', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({ userId: 'user_42' });
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(mcpJson.mcpServers['feishu-server'].env?.YOURBOT_USER_ID).toBe('user_42');
      expect(mcpJson.mcpServers['memory-server'].env?.YOURBOT_USER_ID).toBe('user_42');
      expect(mcpJson.mcpServers['memory-server'].env?.MEMORY_STORE_PATH).toBe(
        '/data/yourbot/memory/user_42',
      );
    });

    test('应该包含有权限的第三方 Server', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({
        userPermissions: ['github:read'],
        tenantConfig: {
          thirdPartyServers: [
            {
              id: 'github-server',
              command: 'node',
              args: ['github-mcp.js'],
              requiredPermissions: ['github:read'],
            },
          ],
        },
      });
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(mcpJson.mcpServers['github-server']).toBeDefined();
      expect(mcpJson.mcpServers['github-server'].command).toBe('node');
    });

    test('应该过滤无权限的第三方 Server', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({
        userPermissions: [],
        tenantConfig: {
          thirdPartyServers: [
            {
              id: 'admin-server',
              command: 'node',
              args: ['admin-mcp.js'],
              requiredPermissions: ['admin:full'],
            },
          ],
        },
      });
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(mcpJson.mcpServers['admin-server']).toBeUndefined();
    });

    test('应该包含当前用户的自定义 Server', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({
        userId: 'user_001',
        tenantConfig: {
          customServers: [
            {
              id: 'my-server',
              ownerId: 'user_001',
              transport: 'stdio',
              command: 'python',
              args: ['my-server.py'],
            },
            {
              id: 'other-server',
              ownerId: 'user_002',
              transport: 'stdio',
              command: 'python',
              args: ['other.py'],
            },
          ],
        },
      });
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(mcpJson.mcpServers['my-server']).toBeDefined();
      expect(mcpJson.mcpServers['other-server']).toBeUndefined();
    });

    test('SSE 类型的自定义 Server 应该使用 url', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({
        tenantConfig: {
          customServers: [
            {
              id: 'sse-server',
              ownerId: 'user_001',
              transport: 'sse',
              url: 'http://localhost:3001/sse',
            },
          ],
        },
      });
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(mcpJson.mcpServers['sse-server'].url).toBe('http://localhost:3001/sse');
      expect(mcpJson.mcpServers['sse-server'].command).toBeUndefined();
    });

    test('应该解析第三方 Server 环境变量中的模板', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({
        userId: 'user_99',
        tenantId: 'tenant_55',
        userPermissions: ['tool:use'],
        tenantConfig: {
          thirdPartyServers: [
            {
              id: 'templated-server',
              command: 'node',
              args: ['server.js'],
              env: { OWNER: '{{USER_ID}}', TENANT: '{{TENANT_ID}}' },
              requiredPermissions: ['tool:use'],
            },
          ],
        },
      });
      generator.generateMcpJson(context);

      const mcpJson: McpJsonConfig = JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));

      expect(mcpJson.mcpServers['templated-server'].env?.OWNER).toBe('user_99');
      expect(mcpJson.mcpServers['templated-server'].env?.TENANT).toBe('tenant_55');
    });
  });

  describe('generateClaudeSettings', () => {
    test('应该生成包含 MCP 权限的 settings.json', () => {
      const generator = new McpConfigGenerator();
      const context = createContext();
      generator.generateClaudeSettings(context);

      const settings = JSON.parse(
        readFileSync(join(TEST_DIR, '.claude', 'settings.json'), 'utf-8'),
      );

      expect(settings.permissions.allow).toContain('mcp__feishu_server__*');
      expect(settings.permissions.allow).toContain('mcp__memory_server__*');
      expect(settings.permissions.allow).toContain('mcp__scheduler_server__*');
      expect(settings.permissions.allow).toContain('Bash(*)');
      expect(settings.model).toBe('claude-sonnet-4-20250514');
    });

    test('应该包含租户级拒绝规则', () => {
      const generator = new McpConfigGenerator();
      const context = createContext({
        tenantConfig: {
          deniedTools: ['Bash(rm -rf *)', 'mcp__admin__delete_all'],
        },
      });
      generator.generateClaudeSettings(context);

      const settings = JSON.parse(
        readFileSync(join(TEST_DIR, '.claude', 'settings.json'), 'utf-8'),
      );

      expect(settings.permissions.deny).toContain('Bash(rm -rf *)');
      expect(settings.permissions.deny).toContain('mcp__admin__delete_all');
    });
  });
});
