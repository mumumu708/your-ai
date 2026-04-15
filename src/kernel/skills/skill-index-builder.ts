/**
 * Generates the skill index for system prompt L4.
 *
 * The index is a compact listing of available skills with readiness status,
 * consuming ≤ 1% of the context window budget.
 */

import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import { type SkillFrontmatter, parseFrontmatter } from './skill-frontmatter';
import { type ReadinessResult, checkReadiness } from './skill-readiness';

export interface SkillEntry {
  name: string;
  description: string;
  dir: string;
  tags?: string[];
}

export interface SkillIndexParams {
  skills: SkillEntry[];
  channel?: string;
  contextWindowSize?: number;
  /** Optional: provide file content loader for testing. Defaults to Bun.file().text(). */
  loadFile?: (path: string) => string | null;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const BUDGET_RATIO = 0.01;

export class SkillIndexBuilder {
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor for bun coverage (P-021)
  constructor() {}

  /**
   * Build a compact skill index string for system prompt injection.
   */
  build(params: SkillIndexParams): string {
    const budget = Math.floor((params.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW) * BUDGET_RATIO);

    const lines = ['# 可用 Skills', '', '需要使用时通过 skill_view 工具加载完整内容。', ''];

    for (const skill of params.skills) {
      const frontmatter = this.loadFrontmatter(skill, params.loadFile);

      // Platform filter
      if (
        frontmatter?.platforms?.length &&
        params.channel &&
        !frontmatter.platforms.includes(params.channel)
      ) {
        continue;
      }

      // Readiness check
      const readiness: ReadinessResult = checkReadiness(frontmatter?.readiness);
      const status = readiness.ready ? '✅' : `⚠️ 缺少: ${readiness.missing.join(', ')}`;

      lines.push(`- **${skill.name}**: ${skill.description} [${status}]`);
    }

    return this.truncateToBudget(lines.join('\n'), budget);
  }

  /**
   * Load and parse frontmatter from a skill's SKILL.md file.
   */
  private loadFrontmatter(
    skill: SkillEntry,
    loadFile?: (path: string) => string | null,
  ): SkillFrontmatter | null {
    const path = `${skill.dir}/SKILL.md`;
    let content: string | null = null;

    if (loadFile) {
      content = loadFile(path);
    } else {
      try {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        content = readFileSync(path, 'utf-8');
      } catch {
        content = null;
      }
    }

    if (!content) return null;

    const { frontmatter } = parseFrontmatter(content);
    return frontmatter;
  }

  /**
   * Write skill descriptions into OpenViking for semantic retrieval (DD-022).
   * Enables per-turn skill recommendations based on query similarity.
   */
  async indexToOpenViking(params: SkillIndexParams, ovClient: OpenVikingClient): Promise<number> {
    let indexed = 0;
    for (const skill of params.skills) {
      const content = [skill.description, skill.tags?.join(', ') ?? ''].filter(Boolean).join('\n');
      await ovClient.write(`viking://skills/${skill.name}`, content);
      indexed++;
    }
    return indexed;
  }

  /**
   * Truncate content to fit within the token budget.
   * Uses character-based estimation (~4 chars per token).
   */
  private truncateToBudget(content: string, budgetTokens: number): string {
    const budgetChars = budgetTokens * 4;
    if (content.length <= budgetChars) return content;

    // Truncate at skill-line granularity
    const lines = content.split('\n');
    const result: string[] = [];
    let totalLength = 0;

    for (const line of lines) {
      if (totalLength + line.length + 1 > budgetChars && result.length > 4) {
        result.push('...(更多 skills 因 token 预算限制省略)');
        break;
      }
      result.push(line);
      totalLength += line.length + 1;
    }

    return result.join('\n');
  }
}
