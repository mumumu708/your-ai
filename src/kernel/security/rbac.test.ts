import { describe, expect, test } from 'bun:test';
import { PermissionChecker } from './rbac';

describe('PermissionChecker', () => {
  test('should default to standard role', () => {
    const checker = new PermissionChecker();
    expect(checker.getRole('user_001')).toBe('standard');
  });

  test('should allow custom default role', () => {
    const checker = new PermissionChecker('guest');
    expect(checker.getRole('user_001')).toBe('guest');
  });

  test('should assign and retrieve roles', () => {
    const checker = new PermissionChecker();
    checker.assignRole('user_001', 'admin', 'system');
    expect(checker.getRole('user_001')).toBe('admin');

    const record = checker.getRoleRecord('user_001');
    expect(record).toBeDefined();
    expect(record?.assignedBy).toBe('system');
    expect(record?.assignedAt).toBeGreaterThan(0);
  });

  test('should remove role and fall back to default', () => {
    const checker = new PermissionChecker();
    checker.assignRole('user_001', 'admin');
    checker.removeRole('user_001');
    expect(checker.getRole('user_001')).toBe('standard');
    expect(checker.getRoleRecord('user_001')).toBeUndefined();
  });

  describe('admin permissions', () => {
    test('admin should have wildcard access', () => {
      const checker = new PermissionChecker();
      checker.assignRole('admin_user', 'admin');
      expect(checker.hasPermission('admin_user', 'agent:create')).toBe(true);
      expect(checker.hasPermission('admin_user', 'file:all')).toBe(true);
      expect(checker.hasPermission('admin_user', 'tool:readonly')).toBe(true);
      expect(checker.hasPermission('admin_user', 'memory:own')).toBe(true);
    });
  });

  describe('power_user permissions', () => {
    test('should have broad permissions', () => {
      const checker = new PermissionChecker();
      checker.assignRole('pu', 'power_user');
      expect(checker.hasPermission('pu', 'agent:create')).toBe(true);
      expect(checker.hasPermission('pu', 'agent:execute')).toBe(true);
      expect(checker.hasPermission('pu', 'tool:all')).toBe(true);
      expect(checker.hasPermission('pu', 'file:all')).toBe(true);
      expect(checker.hasPermission('pu', 'skill:all')).toBe(true);
    });

    test('should have implied permissions', () => {
      const checker = new PermissionChecker();
      checker.assignRole('pu', 'power_user');
      // tool:all implies tool:safe and tool:readonly
      expect(checker.hasPermission('pu', 'tool:safe')).toBe(true);
      expect(checker.hasPermission('pu', 'tool:readonly')).toBe(true);
      // file:all implies file:own and file:read
      expect(checker.hasPermission('pu', 'file:own')).toBe(true);
      expect(checker.hasPermission('pu', 'file:read')).toBe(true);
    });
  });

  describe('standard permissions', () => {
    test('should have limited permissions', () => {
      const checker = new PermissionChecker();
      expect(checker.hasPermission('std', 'agent:execute')).toBe(true);
      expect(checker.hasPermission('std', 'tool:safe')).toBe(true);
      expect(checker.hasPermission('std', 'file:own')).toBe(true);
      expect(checker.hasPermission('std', 'skill:use')).toBe(true);
    });

    test('should not have admin-level permissions', () => {
      const checker = new PermissionChecker();
      expect(checker.hasPermission('std', 'agent:create')).toBe(false);
      expect(checker.hasPermission('std', 'agent:configure')).toBe(false);
      expect(checker.hasPermission('std', 'tool:all')).toBe(false);
      expect(checker.hasPermission('std', 'file:all')).toBe(false);
    });

    test('should have implied lower permissions', () => {
      const checker = new PermissionChecker();
      // tool:safe implies tool:readonly
      expect(checker.hasPermission('std', 'tool:readonly')).toBe(true);
      // file:own implies file:read
      expect(checker.hasPermission('std', 'file:read')).toBe(true);
    });
  });

  describe('guest permissions', () => {
    test('should only have basic permissions', () => {
      const checker = new PermissionChecker('guest');
      expect(checker.hasPermission('guest1', 'agent:execute')).toBe(true);
      expect(checker.hasPermission('guest1', 'tool:readonly')).toBe(true);
      expect(checker.hasPermission('guest1', 'file:read')).toBe(true);
    });

    test('should not have write/own permissions', () => {
      const checker = new PermissionChecker('guest');
      expect(checker.hasPermission('guest1', 'file:own')).toBe(false);
      expect(checker.hasPermission('guest1', 'file:all')).toBe(false);
      expect(checker.hasPermission('guest1', 'memory:own')).toBe(false);
      expect(checker.hasPermission('guest1', 'skill:use')).toBe(false);
    });
  });

  describe('canAccess', () => {
    test('should allow valid access', () => {
      const checker = new PermissionChecker();
      const result = checker.canAccess('std', 'agent', 'execute');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test('should deny invalid access with reason', () => {
      const checker = new PermissionChecker();
      const result = checker.canAccess('std', 'agent', 'create');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('standard');
      expect(result.reason).toContain('agent:create');
    });
  });

  describe('role hierarchy', () => {
    test('should compare roles correctly', () => {
      const checker = new PermissionChecker();
      expect(checker.isHigherRole('admin', 'power_user')).toBe(true);
      expect(checker.isHigherRole('power_user', 'standard')).toBe(true);
      expect(checker.isHigherRole('standard', 'guest')).toBe(true);
      expect(checker.isHigherRole('guest', 'admin')).toBe(false);
      expect(checker.isHigherRole('standard', 'standard')).toBe(false);
    });
  });

  describe('effective permissions', () => {
    test('admin should return wildcard', () => {
      const checker = new PermissionChecker();
      expect(checker.getEffectivePermissions('admin')).toEqual(['*']);
    });

    test('standard should include implied permissions', () => {
      const checker = new PermissionChecker();
      const perms = checker.getEffectivePermissions('standard');
      expect(perms).toContain('tool:safe');
      expect(perms).toContain('tool:readonly'); // implied by tool:safe
      expect(perms).toContain('file:own');
      expect(perms).toContain('file:read'); // implied by file:own
    });

    test('power_user should have all implied permissions', () => {
      const checker = new PermissionChecker();
      const perms = checker.getEffectivePermissions('power_user');
      expect(perms).toContain('tool:all');
      expect(perms).toContain('tool:safe');
      expect(perms).toContain('tool:readonly');
      expect(perms).toContain('file:all');
      expect(perms).toContain('file:own');
      expect(perms).toContain('file:read');
      expect(perms).toContain('memory:all');
      expect(perms).toContain('memory:own');
      expect(perms).toContain('skill:all');
      expect(perms).toContain('skill:use');
    });
  });
});
