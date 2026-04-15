import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import { retrieveMemories } from '../memory/memory-retriever-v2';
import type { ContextSummary } from '../memory/memory-types';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';
import type { AIEOSConfig, ConfigLoader } from '../prompt/config-loader';
import type { ConflictResolver } from '../prompt/conflict-resolver';
import type {
  KnowledgeFragment,
  KnowledgeRouterConfig,
  ResolvedContext,
  WorkspaceInfo,
} from './evolution-types';
import { DEFAULT_ROUTER_CONFIG } from './evolution-types';
import type { TokenBudgetAllocator } from './token-budget-allocator';
import type { BudgetRatios } from './token-budget-allocator';

export interface KnowledgeRouterDeps {
  configLoader: ConfigLoader;
  ovClient: OpenVikingClient;
  conflictResolver: ConflictResolver;
  tokenBudgetAllocator: TokenBudgetAllocator;
}

export class KnowledgeRouter {
  private readonly logger = new Logger('KnowledgeRouter');
  private readonly configLoader: ConfigLoader;
  private readonly ovClient: OpenVikingClient;
  private readonly conflictResolver: ConflictResolver;
  private readonly allocator: TokenBudgetAllocator;
  private readonly config: KnowledgeRouterConfig;

  constructor(deps: KnowledgeRouterDeps, config?: Partial<KnowledgeRouterConfig>) {
    this.configLoader = deps.configLoader;
    this.ovClient = deps.ovClient;
    this.conflictResolver = deps.conflictResolver;
    this.allocator = deps.tokenBudgetAllocator;
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  async buildContext(
    userId: string,
    currentMessage: string,
    recentMessages: ConversationMessage[],
    complexity: 'simple' | 'complex',
    options?: {
      summaries?: ContextSummary[];
      workspaceInfo?: WorkspaceInfo;
      anchorText?: string;
      configLoader?: { loadAll(forceRefresh?: boolean): Promise<AIEOSConfig> };
    },
  ): Promise<ResolvedContext> {
    const fragments: KnowledgeFragment[] = [];

    // 1. Load all AIEOS config files at once via ConfigLoader (per-user override if available)
    const aieosConfig = await (options?.configLoader ?? this.configLoader).loadAll();

    fragments.push(this.toFragment('identity', aieosConfig.identity, 10));

    // 2. Classify SOUL rules line by line
    const soulLines = aieosConfig.soul.split('\n').filter((l) => l.trim().length > 0);
    for (const line of soulLines) {
      const ruleClass = this.conflictResolver.classifyRule(line);
      const priority = ruleClass === 'safety' || ruleClass === 'compliance' ? 10 : 6;
      fragments.push(this.toFragment('soul', line, priority, ruleClass));
    }

    // 3. Classify USER rules
    const userLines = aieosConfig.user.split('\n').filter((l) => l.trim().length > 0);
    for (const line of userLines) {
      const ruleClass = this.conflictResolver.classifyRule(line);
      const priority = ruleClass === 'preference' || ruleClass === 'style' ? 8 : 7;
      fragments.push(this.toFragment('user', line, priority, ruleClass));
    }

    // Simple tasks: only identity + soul
    if (complexity === 'simple') {
      const { resolved, conflicts } = this.conflictResolver.resolve(
        fragments.filter((f) => f.source === 'identity' || f.source === 'soul'),
      );

      const budget = Math.floor(this.config.maxContextTokens * 0.3);
      const allocated = this.allocator.allocate(resolved, budget, {
        identity: 0.6,
        memory: 0.2,
        session: 0.2,
      });

      const systemPrompt = this.assemblePrompt(allocated);
      const totalTokens = allocated.reduce((sum, f) => sum + f.tokens, 0);

      return {
        systemPrompt,
        fragments: allocated,
        totalTokens,
        conflictsResolved: conflicts,
        retrievedMemories: [],
      };
    }

    // Complex tasks: full pipeline with OpenViking retrieval
    // 4. Build search query
    const query = this.buildSearchQuery(currentMessage, recentMessages);

    // 5. Retrieve memories via OpenViking
    if (query) {
      const memories = await retrieveMemories(this.ovClient, {
        query,
        tokenBudget: this.config.maxContextTokens * this.config.memoryBudgetRatio,
        memoryTopK: this.config.maxMemoryResults,
      });

      for (const mem of memories) {
        fragments.push({
          source: 'memory',
          content: mem.content,
          priority: 4,
          tokens: this.allocator.estimateTokens(mem.content),
        });
      }
    }

    // 6. Add compressed summaries from WorkingMemory
    if (options?.summaries && options.summaries.length > 0) {
      const summaryContent = options.summaries
        .map((s) => `[${s.messageCount}条消息摘要] ${s.content}`)
        .join('\n');
      fragments.push(this.toFragment('session', summaryContent, 3));
    }

    // 7. Add anchor text from Pre-Compaction flush
    if (options?.anchorText) {
      fragments.push(this.toFragment('session', options.anchorText, 5));
    }

    // 8. Add session context from recent messages
    if (recentMessages.length > 0) {
      const sessionContext = recentMessages
        .slice(-5)
        .map((m) => `${m.role}: ${m.content.slice(0, 100)}`)
        .join('\n');
      fragments.push(this.toFragment('session', sessionContext, 2));
    }

    // 9. Add workspace info
    if (options?.workspaceInfo) {
      const wsInfo = options.workspaceInfo;
      const wsParts: string[] = [];
      if (wsInfo.availableSkills.length > 0) {
        wsParts.push(`可用技能: ${wsInfo.availableSkills.join(', ')}`);
      }
      if (wsInfo.recentToolsUsed.length > 0) {
        wsParts.push(`最近使用的工具: ${wsInfo.recentToolsUsed.join(', ')}`);
      }
      if (wsParts.length > 0) {
        fragments.push({
          source: 'workspace',
          content: wsParts.join('\n'),
          priority: 3,
          tokens: this.allocator.estimateTokens(wsParts.join('\n')),
        });
      }
    }

    // 10. Conflict resolution
    const { resolved, conflicts } = this.conflictResolver.resolve(fragments);

    // 11. Token budget allocation
    const ratios: BudgetRatios = {
      identity: this.config.identityBudgetRatio,
      memory: this.config.memoryBudgetRatio,
      session: this.config.sessionBudgetRatio,
    };
    const allocated = this.allocator.allocate(resolved, this.config.maxContextTokens, ratios);

    // 12. Assemble system prompt
    const systemPrompt = this.assemblePrompt(allocated);
    const totalTokens = allocated.reduce((sum, f) => sum + f.tokens, 0);

    this.logger.info('上下文构建完成', {
      userId,
      complexity,
      fragmentCount: allocated.length,
      totalTokens,
      conflictCount: conflicts.length,
    });

    return {
      systemPrompt,
      fragments: allocated,
      totalTokens,
      conflictsResolved: conflicts,
      retrievedMemories: [],
    };
  }

  private toFragment(
    source: KnowledgeFragment['source'],
    content: string,
    priority: number,
    ruleClass?: KnowledgeFragment['ruleClass'],
  ): KnowledgeFragment {
    return {
      source,
      content,
      priority,
      tokens: this.allocator.estimateTokens(content),
      ruleClass,
    };
  }

  private buildSearchQuery(currentMessage: string, recentMessages: ConversationMessage[]): string {
    const parts = [currentMessage];

    const userMessages = recentMessages
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content.slice(0, 50));

    parts.push(...userMessages);
    return parts.join(' ');
  }

  private assemblePrompt(fragments: KnowledgeFragment[]): string {
    const sections = {
      identity: [] as string[],
      soul: [] as string[],
      user: [] as string[],
      memory: [] as string[],
      session: [] as string[],
      workspace: [] as string[],
    };

    for (const fragment of fragments) {
      const bucket = sections[fragment.source as keyof typeof sections];
      if (bucket) {
        bucket.push(fragment.content);
      }
    }

    const parts: string[] = [];

    if (sections.identity.length > 0) {
      parts.push(`--- Agent Identity ---\n${sections.identity.join('\n')}`);
    }
    if (sections.soul.length > 0) {
      parts.push(`--- Agent Soul ---\n${sections.soul.join('\n')}`);
    }
    if (sections.user.length > 0) {
      parts.push(`--- User Profile ---\n${sections.user.join('\n')}`);
    }
    if (sections.memory.length > 0) {
      parts.push(`--- Relevant Memories ---\n${sections.memory.join('\n')}`);
    }
    if (sections.session.length > 0) {
      parts.push(`--- Session Context ---\n${sections.session.join('\n')}`);
    }
    if (sections.workspace.length > 0) {
      parts.push(`--- Workspace ---\n${sections.workspace.join('\n')}`);
    }

    return parts.join('\n\n');
  }
}
