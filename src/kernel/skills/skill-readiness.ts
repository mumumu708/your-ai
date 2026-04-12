/**
 * Skill readiness checker — verifies that a skill's dependencies are satisfied.
 */

export interface SkillReadiness {
  env?: string[];
  tools?: string[];
  credentials?: string[];
}

export interface ReadinessResult {
  ready: boolean;
  missing: string[];
}

/**
 * Check if a skill has all its dependencies satisfied.
 * - env: checks process.env for each variable name
 * - credentials: deferred (needs runtime file system access)
 * - tools: deferred (needs MCP registry which doesn't exist yet)
 */
export function checkReadiness(readiness: SkillReadiness | undefined): ReadinessResult {
  if (!readiness) return { ready: true, missing: [] };
  const missing: string[] = [];

  for (const name of readiness.env ?? []) {
    if (!process.env[name]) missing.push(`env:${name}`);
  }

  // Credentials check deferred — needs runtime file system access
  // Tools check deferred — needs MCP registry

  return { ready: missing.length === 0, missing };
}
