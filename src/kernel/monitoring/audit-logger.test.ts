import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { type AuditLogEntry, AuditLogger, InMemoryAuditStore } from './audit-logger';

describe('AuditLogger', () => {
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

  function createEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
    return {
      timestamp: new Date().toISOString(),
      eventType: 'tool_call',
      sessionId: 'sess_001',
      userId: 'user_001',
      tenantId: 'tenant_001',
      serverId: 'feishu-server',
      ...overrides,
    };
  }

  describe('log', () => {
    test('应该将条目追加到 store', async () => {
      const store = new InMemoryAuditStore();
      const logger = new AuditLogger(store);

      await logger.log(createEntry({ toolName: 'feishu_send_message' }));

      const entries = store.getEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].toolName).toBe('feishu_send_message');
    });

    test('应该脱敏敏感字段', async () => {
      const store = new InMemoryAuditStore();
      const logger = new AuditLogger(store);

      await logger.log(
        createEntry({
          input: {
            target: 'user_123',
            api_key: 'sk-secret-123',
            password: 'mypass',
            content: 'hello',
          },
        }),
      );

      const entries = store.getEntries();
      const input = entries[0].input;
      if (!input) throw new Error('Expected audit entry to have input');
      expect(input.target).toBe('user_123');
      expect(input.content).toBe('hello');
      expect(input.api_key).toBe('[REDACTED]');
      expect(input.password).toBe('[REDACTED]');
    });
  });

  describe('redactSensitiveFields', () => {
    test('应该递归脱敏嵌套对象', () => {
      const logger = new AuditLogger();
      const result = logger.redactSensitiveFields({
        name: 'test',
        config: {
          token: 'abc123',
          url: 'http://example.com',
        },
      });

      expect(result.name).toBe('test');
      expect((result.config as Record<string, unknown>).token).toBe('[REDACTED]');
      expect((result.config as Record<string, unknown>).url).toBe('http://example.com');
    });

    test('应该处理各种敏感 key 变体', () => {
      const logger = new AuditLogger();
      const result = logger.redactSensitiveFields({
        Authorization: 'Bearer xxx',
        app_secret: 'secret_value',
        credential_id: 'cred_123',
        normal_field: 'visible',
      });

      expect(result.Authorization).toBe('[REDACTED]');
      expect(result.app_secret).toBe('[REDACTED]');
      expect(result.credential_id).toBe('[REDACTED]');
      expect(result.normal_field).toBe('visible');
    });
  });

  describe('InMemoryAuditStore', () => {
    test('query 应该按条件过滤', async () => {
      const store = new InMemoryAuditStore();
      await store.append(createEntry({ userId: 'user_A', eventType: 'tool_call' }));
      await store.append(createEntry({ userId: 'user_B', eventType: 'tool_call' }));
      await store.append(createEntry({ userId: 'user_A', eventType: 'permission_denied' }));

      expect(store.query({ userId: 'user_A' }).length).toBe(2);
      expect(store.query({ eventType: 'permission_denied' }).length).toBe(1);
      expect(store.query({ userId: 'user_A', eventType: 'tool_call' }).length).toBe(1);
    });
  });
});
