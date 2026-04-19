import { Logger } from '../../shared/logging/logger';
import type { ConfigLoader } from '../prompt/config-loader';
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
  'memoryTools',
  'protocol',
];

/**
 * Usage hints for the Viking memory MCP tools.
 * These are DIRECTIVES — the agent MUST follow them when handling user data.
 */
const MEMORY_TOOLS_HINT = `# Memory Tools — 使用指南

## 存储

用户发来的所有消息**已自动保存到 session 历史**（原文完整保留，可通过 session_search 精确检索）。
你不需要手动保存用户的对话内容。

以下情况可主动调用存储工具：
- **viking_remember**：记录一条简短事实/偏好（< 200 字符、单一主题）
  例："用户生日是 1997-12-29"、"用户喜欢听德彪西"
- **viking_add_resource**：导入一个 URL（网页/文档）到知识库

## 回答问题时（重要！）

涉及用户历史信息的问题，**必须先检索再回答**。

### 检索策略：双路并行 + 多轮深挖

**第一轮：双路并行**
1. **session_search**(operation='keyword', query='核心关键词')
   - 用 2-3 个最具辨识度的关键词（人名、地名、专有名词）
   - 例：问"王丽娜工作挑战" → query="王丽娜"
2. **viking_search**(query='语义描述')
   - 用自然语言描述主题
   - 例：query="王丽娜的工作情况"

**第二轮：换关键词重试（如果第一轮结果不足）**
- session_search 换同义词/关联词：
  "晨跑取消" → "下雨 晨跑" → "天气 运动"
- viking_search 换角度：
  "运动习惯调整" → "病愈后恢复" → "体育锻炼变化"
- 搜人名时也搜相关事件："张静" → "闺蜜 聊天"

**第三轮：读取完整内容**
- 找到线索后用 **viking_read**(uri, level='full') 读完整内容
- session_search 的结果如果被截断，用更精确的关键词重搜

### 关键原则
- **禁止凭想象作答** — 检索不到就如实说"没有找到相关记录"
- **宁可多搜不可少搜** — 信息可能分散在不同来源，多个关键词组合搜索
- **注意时间线索** — 问题中提到的月份/日期是重要的检索维度`;

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

    // ── L4: Skill Index ──
    const skillIndex = params.skillIndex || '# 可用 Skills\n暂无';

    // ── L5: Memory Snapshot ──
    const memorySnapshot = params.memorySnapshot ?? buildMemorySnapshot([]);

    // ── L6: Runtime Hints ──
    const runtimeHints = this.buildRuntimeHints(params);

    const sections: PromptSections = {
      identity,
      soul,
      protocol,
      memoryTools: MEMORY_TOOLS_HINT,
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
    if (sections.memoryTools) {
      parts.push(sections.memoryTools);
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
