import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ProcessSecurityManager } from './process-security';

describe('ProcessSecurityManager', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('canSpawn', () => {
    test('空闲时应该返回 true', () => {
      const manager = new ProcessSecurityManager();
      expect(manager.canSpawn()).toBe(true);
    });

    test('达到上限时应该返回 false', () => {
      const manager = new ProcessSecurityManager({ maxProcesses: 2 });
      const mockProc = { pid: 1, kill: () => {} };

      manager.registerProcess('sess_001', mockProc);
      manager.registerProcess('sess_002', { pid: 2, kill: () => {} });

      expect(manager.canSpawn()).toBe(false);

      // Cleanup
      manager.shutdown();
    });
  });

  describe('buildSecureEnv', () => {
    test('应该包含 ANTHROPIC_API_KEY 和 SESSION_ID', () => {
      const manager = new ProcessSecurityManager();
      const env = manager.buildSecureEnv('sk-test-key', 'sess_001');

      expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key');
      expect(env.SESSION_ID).toBe('sess_001');
    });

    test('应该包含 NODE_ENV', () => {
      const manager = new ProcessSecurityManager();
      const env = manager.buildSecureEnv('sk-test-key', 'sess_001');

      expect(env.NODE_ENV).toBeDefined();
    });

    test('应该只包含允许的环境变量键', () => {
      const manager = new ProcessSecurityManager({
        allowedEnvKeys: ['PATH'],
      });
      const env = manager.buildSecureEnv('sk-test', 'sess_001');

      // Should have PATH (if present in actual env), ANTHROPIC_API_KEY, SESSION_ID, NODE_ENV
      const keys = Object.keys(env);
      for (const key of keys) {
        expect(['PATH', 'ANTHROPIC_API_KEY', 'SESSION_ID', 'NODE_ENV'].includes(key)).toBe(true);
      }
    });
  });

  describe('registerProcess / deregisterProcess', () => {
    test('应该正确注册和注销进程', () => {
      const manager = new ProcessSecurityManager();
      const mockProc = { pid: 123, kill: () => {} };

      manager.registerProcess('sess_001', mockProc);
      expect(manager.getActiveProcessCount()).toBe(1);

      manager.deregisterProcess('sess_001');
      expect(manager.getActiveProcessCount()).toBe(0);
    });

    test('注册超过上限时应该抛出错误', () => {
      const manager = new ProcessSecurityManager({ maxProcesses: 1 });
      manager.registerProcess('sess_001', { pid: 1, kill: () => {} });

      expect(() => manager.registerProcess('sess_002', { pid: 2, kill: () => {} })).toThrow(
        '进程数已达上限',
      );

      manager.shutdown();
    });

    test('进程超时应该自动清理', async () => {
      const killSpy = spyOn({ kill: () => {} }, 'kill');
      const mockProc = { pid: 456, kill: killSpy };
      const manager = new ProcessSecurityManager({
        processTimeoutMs: 50, // 50ms for test
      });

      manager.registerProcess('sess_001', mockProc);
      expect(manager.getActiveProcessCount()).toBe(1);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(manager.getActiveProcessCount()).toBe(0);
      expect(killSpy).toHaveBeenCalled();
    });

    test('注销不存在的进程不应该报错', () => {
      const manager = new ProcessSecurityManager();
      expect(() => manager.deregisterProcess('nonexistent')).not.toThrow();
    });
  });

  describe('shutdown', () => {
    test('应该清理所有注册的进程', () => {
      const manager = new ProcessSecurityManager();
      manager.registerProcess('sess_001', { pid: 1, kill: () => {} });
      manager.registerProcess('sess_002', { pid: 2, kill: () => {} });

      manager.shutdown();
      expect(manager.getActiveProcessCount()).toBe(0);
    });
  });
});
