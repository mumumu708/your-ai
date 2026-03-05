import { Logger } from '../../shared/logging/logger';

// ── Types ──────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'power_user' | 'standard' | 'guest';

export type Permission =
  | '*'
  | 'agent:create'
  | 'agent:execute'
  | 'agent:configure'
  | 'tool:all'
  | 'tool:safe'
  | 'tool:readonly'
  | 'file:all'
  | 'file:own'
  | 'file:read'
  | 'memory:all'
  | 'memory:own'
  | 'skill:all'
  | 'skill:use';

export type ResourceType = 'agent' | 'tool' | 'file' | 'memory' | 'skill';

export interface UserRoleRecord {
  userId: string;
  role: Role;
  assignedBy: string;
  assignedAt: number;
}

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const ROLE_HIERARCHY: Record<Role, number> = {
  admin: 100,
  power_user: 50,
  standard: 20,
  guest: 10,
};

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['*'],
  power_user: [
    'agent:create',
    'agent:execute',
    'agent:configure',
    'tool:all',
    'file:all',
    'memory:all',
    'skill:all',
  ],
  standard: ['agent:execute', 'tool:safe', 'file:own', 'memory:own', 'skill:use'],
  guest: ['agent:execute', 'tool:readonly', 'file:read'],
};

/**
 * Maps higher-level permissions to the narrower ones they include.
 * e.g. 'file:all' implies 'file:own' and 'file:read'.
 */
const PERMISSION_IMPLIES: Partial<Record<Permission, Permission[]>> = {
  'tool:all': ['tool:safe', 'tool:readonly'],
  'tool:safe': ['tool:readonly'],
  'file:all': ['file:own', 'file:read'],
  'file:own': ['file:read'],
  'memory:all': ['memory:own'],
  'skill:all': ['skill:use'],
};

// ── PermissionChecker ──────────────────────────────────────────────────────

/**
 * RBAC permission checker.
 * Manages user → role mapping and permission checks.
 */
export class PermissionChecker {
  private readonly logger = new Logger('PermissionChecker');
  private readonly roles = new Map<string, UserRoleRecord>();
  private readonly defaultRole: Role;

  constructor(defaultRole: Role = 'standard') {
    this.defaultRole = defaultRole;
  }

  /**
   * Assign a role to a user.
   */
  assignRole(userId: string, role: Role, assignedBy = 'system'): void {
    this.roles.set(userId, {
      userId,
      role,
      assignedBy,
      assignedAt: Date.now(),
    });
    this.logger.info(`Role assigned: ${userId} → ${role} by ${assignedBy}`);
  }

  /**
   * Remove explicit role assignment; user falls back to default.
   */
  removeRole(userId: string): void {
    this.roles.delete(userId);
  }

  /**
   * Get a user's current role.
   */
  getRole(userId: string): Role {
    return this.roles.get(userId)?.role ?? this.defaultRole;
  }

  /**
   * Get the full role record (or undefined if no explicit assignment).
   */
  getRoleRecord(userId: string): UserRoleRecord | undefined {
    return this.roles.get(userId);
  }

  /**
   * Check if a user has a specific permission.
   */
  hasPermission(userId: string, permission: Permission): boolean {
    const role = this.getRole(userId);
    const perms = ROLE_PERMISSIONS[role];

    // Admin wildcard
    if (perms.includes('*')) return true;

    // Direct match
    if (perms.includes(permission)) return true;

    // Check implication: does the user hold a broader permission?
    for (const held of perms) {
      const implied = PERMISSION_IMPLIES[held];
      if (implied?.includes(permission)) return true;
    }

    return false;
  }

  /**
   * Check if a user can access a specific resource type with a given action.
   * action follows the pattern: `resourceType:level`
   */
  canAccess(userId: string, resource: ResourceType, action: string): AccessCheckResult {
    const permission = `${resource}:${action}` as Permission;
    const allowed = this.hasPermission(userId, permission);

    if (!allowed) {
      const role = this.getRole(userId);
      return {
        allowed: false,
        reason: `角色 '${role}' 无权限 '${permission}'`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if one role is higher than another.
   */
  isHigherRole(a: Role, b: Role): boolean {
    return ROLE_HIERARCHY[a] > ROLE_HIERARCHY[b];
  }

  /**
   * List all permissions for a role (including implied).
   */
  getEffectivePermissions(role: Role): Permission[] {
    const direct = ROLE_PERMISSIONS[role];
    if (direct.includes('*')) return ['*'];

    const all = new Set<Permission>(direct);
    for (const perm of direct) {
      const implied = PERMISSION_IMPLIES[perm];
      if (implied) {
        for (const imp of implied) all.add(imp);
      }
    }
    return [...all];
  }
}
