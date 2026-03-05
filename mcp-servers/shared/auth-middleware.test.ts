import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAuthMiddleware } from './auth-middleware';

describe('AuthMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.YOURBOT_USER_ID = 'user_001';
    process.env.YOURBOT_TENANT_ID = 'tenant_001';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('应该从环境变量读取身份信息', () => {
    const auth = createAuthMiddleware();
    const ctx = auth.getContext();
    expect(ctx.userId).toBe('user_001');
    expect(ctx.tenantId).toBe('tenant_001');
  });

  test('应该在 YOURBOT_USER_ID 缺失时抛出错误', () => {
    delete process.env.YOURBOT_USER_ID;
    expect(() => createAuthMiddleware()).toThrow('YOURBOT_USER_ID');
  });

  test('assertAccess 应该允许访问自己的资源', () => {
    const auth = createAuthMiddleware();
    expect(() => auth.assertAccess('user_001')).not.toThrow();
  });

  test('assertAccess 应该拒绝访问他人的资源', () => {
    const auth = createAuthMiddleware();
    expect(() => auth.assertAccess('user_002')).toThrow('Access denied');
  });

  test('tenantId 可以为空', () => {
    delete process.env.YOURBOT_TENANT_ID;
    const auth = createAuthMiddleware();
    expect(auth.getContext().tenantId).toBe('');
  });
});
