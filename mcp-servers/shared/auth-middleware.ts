/**
 * Auth middleware for MCP Server internal authentication.
 * Each MCP Server receives caller identity via environment variables
 * set by McpConfigGenerator during workspace initialization.
 */

export interface AuthContext {
  userId: string;
  tenantId: string;
}

export interface AuthMiddleware {
  getContext(): AuthContext;
  assertAccess(resourceOwnerId: string): void;
}

/**
 * Create an auth middleware that reads identity from environment variables.
 * Throws if YOURBOT_USER_ID is not set.
 */
export function createAuthMiddleware(): AuthMiddleware {
  const authContext: AuthContext = {
    userId: process.env.YOURBOT_USER_ID ?? '',
    tenantId: process.env.YOURBOT_TENANT_ID ?? '',
  };

  if (!authContext.userId) {
    throw new Error('YOURBOT_USER_ID environment variable is required');
  }

  return {
    getContext: () => authContext,

    assertAccess(resourceOwnerId: string): void {
      if (resourceOwnerId !== authContext.userId) {
        throw new Error(
          `Access denied: user ${authContext.userId} ` +
          `cannot access resource owned by ${resourceOwnerId}`,
        );
      }
    },
  };
}
