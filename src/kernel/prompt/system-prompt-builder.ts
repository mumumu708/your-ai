import { Logger } from '../../shared/logging/logger';
import type { ConfigLoader } from '../memory/config-loader';
import { buildMemorySnapshot } from './memory-snapshot-builder';
import {
  CHANNEL_CAPABILITIES,
  type FrozenSystemPrompt,
  type PromptBuildParams,
  type PromptSections,
  SYSTEM_PROMPT_BUDGET,
  estimateTokens,
} from './prompt-types';

/** Section trim priority — higher index = trimmed first */
const TRIM_ORDER: (keyof PromptSections)[] = [
  'runtimeHints',
  'memorySnapshot',
  'skillIndex',
  'protocol',
];

/**
 * Builds the frozen system prompt (session-level, stable).
 *
 * Called once at session start and after compaction.
 * Sections are assembled in fixed order for prefix cache stability.
 */
export class SystemPromptBuilder {
  private readonly logger = new Logger('SystemPromptBuilder');

  constructor(private readonly configLoader: ConfigLoader) {}

  async build(params: PromptBuildParams): Promise<FrozenSystemPrompt> {
    // ── L1: Identity ──
    const identity = await this.configLoader.loadFile('IDENTITY.md');

    // ── L2: Soul ──
    const soul = await this.configLoader.loadFile('SOUL.md');

    // ── L3: Core Protocol ──
    const fullAgents = await this.configLoader.loadFile('AGENTS.md');
    const protocol = this.extractCoreProtocol(fullAgents);

    // ── L4: Skill Index (placeholder — DD-015 not yet implemented) ──
    const skillIndex = '# 可用 Skills\n暂无';

    // ── L5: Memory Snapshot ──
    const memorySnapshot = buildMemorySnapshot([]);

    // ── L6: Runtime Hints ──
    const runtimeHints = this.buildRuntimeHints(params);

    const sections: PromptSections = {
      identity,
      soul,
      protocol,
      skillIndex,
      memorySnapshot,
      runtimeHints,
    };

    const content = this.assemble(sections);
    const totalTokens = estimateTokens(content);

    if (totalTokens > SYSTEM_PROMPT_BUDGET) {
      this.logger.warn('System prompt exceeds budget, trimming', {
        totalTokens,
        budget: SYSTEM_PROMPT_BUDGET,
        sections: Object.fromEntries(
          Object.entries(sections).map(([k, v]) => [k, estimateTokens(v)]),
        ),
      });
      return this.trimToBudget(sections);
    }

    return { content, totalTokens, builtAt: Date.now(), sections };
  }

  /**
   * Assemble sections in fixed order for prefix cache stability.
   */
  assemble(sections: PromptSections): string {
    const parts: string[] = [];

    if (sections.identity) {
      parts.push(sections.identity);
    }
    if (sections.soul) {
      parts.push(sections.soul);
    }
    if (sections.protocol) {
      parts.push(`# 操作规范\n${sections.protocol}`);
    }
    if (sections.skillIndex) {
      parts.push(sections.skillIndex);
    }
    if (sections.memorySnapshot) {
      parts.push(sections.memorySnapshot);
    }
    if (sections.runtimeHints) {
      parts.push(`# Runtime\n${sections.runtimeHints}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Extract behavioral rules from AGENTS.md.
   * Keeps only section headers matching known protocol sections.
   * Target: ≤ 500 tokens.
   */
  extractCoreProtocol(fullAgents: string): string {
    const targetSections = ['Memory 交互协议', '工具使用规范', '会话管理', 'Skill 维护协议'];

    const lines = fullAgents.split('\n');
    const extracted: string[] = [];
    let capturing = false;
    let currentLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,4})\s+(.+)/);

      if (headingMatch) {
        const level = headingMatch[1]?.length ?? 0;
        const title = headingMatch[2]?.trim() ?? '';

        if (targetSections.some((s) => title.includes(s))) {
          capturing = true;
          currentLevel = level;
          extracted.push(line);
          continue;
        }

        // Stop capturing when we hit a heading at same or higher level
        if (capturing && level <= currentLevel) {
          capturing = false;
        }
      }

      if (capturing) {
        extracted.push(line);
      }
    }

    return extracted.join('\n').trim();
  }

  private buildRuntimeHints(params: PromptBuildParams): string {
    const lines: string[] = [];
    lines.push(`- 时间：${new Date().toISOString()}`);
    lines.push(`- 通道：${params.channel}`);
    if (params.workspacePath) {
      lines.push(`- 工作目录：${params.workspacePath}`);
    }

    const channelCaps = CHANNEL_CAPABILITIES[params.channel];
    if (channelCaps) {
      lines.push(`- 通道能力：${channelCaps.join(', ')}`);
    }

    return lines.join('\n');
  }

  private trimToBudget(sections: PromptSections): FrozenSystemPrompt {
    const trimmed = { ...sections };

    for (const key of TRIM_ORDER) {
      const content = this.assemble(trimmed);
      const tokens = estimateTokens(content);
      if (tokens <= SYSTEM_PROMPT_BUDGET) break;

      // Progressively trim: first halve, then empty
      if (trimmed[key].length > 0) {
        const currentTokens = estimateTokens(trimmed[key]);
        if (currentTokens > 100) {
          // Halve it first
          const halfLength = Math.floor(trimmed[key].length / 2);
          trimmed[key] = `${trimmed[key].slice(0, halfLength)}...`;
        } else {
          trimmed[key] = '';
        }
      }
    }

    // If still over budget after first pass, aggressively clear
    for (const key of TRIM_ORDER) {
      const content = this.assemble(trimmed);
      if (estimateTokens(content) <= SYSTEM_PROMPT_BUDGET) break;
      trimmed[key] = '';
    }

    const content = this.assemble(trimmed);
    return {
      content,
      totalTokens: estimateTokens(content),
      builtAt: Date.now(),
      sections: trimmed,
    };
  }
}
