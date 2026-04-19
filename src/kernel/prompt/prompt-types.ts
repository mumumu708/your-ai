/**
 * DD-018: System Prompt Builder 类型定义
 *
 * 三级缓存架构：
 * - FrozenSystemPrompt: session 级冻结区（L1-L6）
 * - TurnContext: 每轮注入区（memory/guidance/delta）
 * - PrependContext: 首轮 OVERRIDE 语义注入
 */

export interface FrozenSystemPrompt {
  content: string;
  totalTokens: number;
  builtAt: number;
  sections: PromptSections;
}

export interface PromptSections {
  identity: string;
  soul: string;
  protocol: string;
  /** Viking MCP tool usage hints (when to remember vs add_resource vs search) */
  memoryTools: string;
  skillIndex: string;
  memorySnapshot: string;
  runtimeHints: string;
}

export interface TurnContext {
  content: string;
  totalTokens: number;
}

export interface PromptBuildParams {
  userId: string;
  channel: string;
  workspacePath?: string;
  skillIndex?: string;
  memorySnapshot?: string;
}

export interface SkillRecommendation {
  name: string;
  description: string;
}

export interface TurnContextBuildParams {
  memories?: RetrievedMemory[];
  executionMode?: string;
  taskType?: string;
  /** 外部注入的 task-guidance 文本（优先于内部 hardcoded 生成） */
  taskGuidance?: string;
  /** 语义匹配的 skill 推荐（DD-022） */
  skillRecommendations?: SkillRecommendation[];
  invokedSkills?: string[];
  postCompaction?: boolean;
  mcpServers?: {
    current: string[];
    previous: string[];
  };
  /** 消化系统产生的待推送洞察（DD-022） */
  digestInsights?: Array<{ topic: string; preview: string }>;
}

export interface RetrievedMemory {
  content: string;
  updatedAt: number;
}

/** Token budget: frozen system prompt */
export const SYSTEM_PROMPT_BUDGET = 3000;

/** Token budget: per-turn memory context */
export const MEMORY_CONTEXT_BUDGET = 2000;

/** Skill index share of context window */
export const SKILL_INDEX_BUDGET_PERCENT = 0.01;

/** Channel capability declarations */
export const CHANNEL_CAPABILITIES: Record<string, string[]> = {
  feishu: ['流式卡片更新', '文件上传下载', '群聊创建'],
  telegram: ['消息编辑(2s限流)', '文件发送'],
  web: ['WebSocket实时推送', '无限流式'],
};

/**
 * Rough token estimate: ~4 chars per token for mixed CJK/English.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
