import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpJsonConfig } from './mcp-config-generator';
import { McpConfigUpdater } from './mcp-config-updater';

const TEST_DIR = join(import.meta.dir, '__test_mcp_updater__');

describe('McpConfigUpdater', () => {
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

  function writeMcpJson(servers: Record<string, unknown>): void {
    const config: McpJsonConfig = { mcpServers: servers as McpJsonConfig['mcpServers'] };
    writeFileSync(join(TEST_DIR, '.mcp.json'), JSON.stringify(config, null, 2), 'utf-8');
  }

  function readMcpJson(): McpJsonConfig {
    return JSON.parse(readFileSync(join(TEST_DIR, '.mcp.json'), 'utf-8'));
  }

  describe('addServer', () => {
    test('应该调用 claude mcp add-json 命令', async () => {
      const spawnCalls: Array<{ cmd: string[]; cwd: string }> = [];
      const updater = new McpConfigUpdater({
        spawn: async (cmd, cwd) => {
          spawnCalls.push({ cmd, cwd });
          return { exitCode: 0 };
        },
      });

      await updater.addServer(TEST_DIR, 'new-server', {
        command: 'node',
        args: ['server.js'],
      });

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].cmd[0]).toBe('claude');
      expect(spawnCalls[0].cmd[1]).toBe('mcp');
      expect(spawnCalls[0].cmd[2]).toBe('add-json');
      expect(spawnCalls[0].cmd[3]).toBe('new-server');
      expect(spawnCalls[0].cwd).toBe(TEST_DIR);
    });

    test('应该在命令失败时抛出错误', async () => {
      const updater = new McpConfigUpdater({
        spawn: async () => ({ exitCode: 1 }),
      });

      try {
        await updater.addServer(TEST_DIR, 'bad-server', { command: 'bad' });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('bad-server');
        expect((error as Error).message).toContain('exit code 1');
      }
    });
  });

  describe('removeServer', () => {
    test('应该从 .mcp.json 中移除指定 Server', () => {
      writeMcpJson({
        'server-a': { command: 'a' },
        'server-b': { command: 'b' },
      });

      const updater = new McpConfigUpdater();
      updater.removeServer(TEST_DIR, 'server-a');

      const config = readMcpJson();
      expect(config.mcpServers['server-a']).toBeUndefined();
      expect(config.mcpServers['server-b']).toBeDefined();
    });

    test('应该在 .mcp.json 不存在时抛出错误', () => {
      const updater = new McpConfigUpdater();
      expect(() => updater.removeServer(TEST_DIR, 'any')).toThrow('.mcp.json not found');
    });

    test('应该在 Server 不存在时静默返回', () => {
      writeMcpJson({ existing: { command: 'x' } });
      const updater = new McpConfigUpdater();
      updater.removeServer(TEST_DIR, 'nonexistent');

      const config = readMcpJson();
      expect(config.mcpServers.existing).toBeDefined();
    });
  });

  describe('listServers', () => {
    test('应该列出所有已配置的 Server', () => {
      writeMcpJson({
        'server-a': { command: 'a' },
        'server-b': { command: 'b' },
      });

      const updater = new McpConfigUpdater();
      const servers = updater.listServers(TEST_DIR);
      expect(Object.keys(servers)).toEqual(['server-a', 'server-b']);
    });

    test('应该在 .mcp.json 不存在时返回空对象', () => {
      const updater = new McpConfigUpdater();
      const servers = updater.listServers(TEST_DIR);
      expect(servers).toEqual({});
    });
  });
});
