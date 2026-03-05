export type SkillSourceType = 'builtin' | 'marketplace' | 'custom';

export type SkillTier = 'basic' | 'advanced';

export interface SkillSource {
  type: SkillSourceType;
  sourcePath: string;
}

export interface SkillInfo {
  name: string;
  command: string; // e.g. "/deploy-staging"
  tier: SkillTier;
  source: SkillSourceType;
}

export interface DeployResult {
  deployed: string[];
  skipped: string[];
  errors: Array<{ skill: string; error: string }>;
}

export interface SkillContent {
  /** Markdown content of the skill command file */
  content: string;
  /** Optional scripts keyed by filename */
  scripts?: Record<string, string>;
  /** Optional assets keyed by filename */
  assets?: Record<string, string>;
}

export interface SkillDeployerConfig {
  builtinSkillsDir?: string;
  marketplaceSkillsDir?: string;
}
