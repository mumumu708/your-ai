import { LessonsLearnedUpdater } from '../lessons/lessons-updater';
import type { UnifiedClassifyResult } from '../shared/classifier/classifier-types';
import { ERROR_CODES } from '../shared/errors/error-codes';
import { YourBotError } from '../shared/errors/yourbot-error';
import { Logger } from '../shared/logging/logger';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { IChannel } from '../shared/messaging/channel-adapter.types';
import type { MediaRef } from '../shared/messaging/media-attachment.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import type { TaskResult } from '../shared/tasking/task-result.types';
import type { Session, Task, TaskType } from '../shared/tasking/task.types';
import { isAdminUser } from '../shared/utils/admin';
import { generateTaskId, generateTraceId } from '../shared/utils/crypto';
import { AgentBridgeWithFallback } from './agents/agent-bridge-fallback';
import { AgentRuntime, type EnhancedAgentResult } from './agents/agent-runtime';
import type { ClaudeAgentBridge } from './agents/claude-agent-bridge';
import { ClaudeBridgeAdapter } from './agents/claude-bridge-adapter';
import { CodexAgentBridge } from './agents/codex-agent-bridge';
import { IntelligenceGateway } from './agents/intelligence-gateway';
import type { LightLlmCompletable } from './agents/intelligence-gateway';
import type { LightLLMClient } from './agents/light-llm-client';
import { McpConfigBuilder } from './agents/mcp-config-builder';
import { TaskGuidanceBuilder } from './agents/task-guidance-builder';
import { TaskClassifier } from './classifier/task-classifier';
import { type AnalysisItem, routeAnalysis } from './evolution/analysis-router';
import { ConflictResolver } from './evolution/conflict-resolver';
import { EvolutionScheduler } from './evolution/evolution-scheduler';
import { FrozenContextManager } from './evolution/frozen-context-manager';
import { KnowledgeRouter } from './evolution/knowledge-router';
import { PostResponseAnalyzer } from './evolution/post-response-analyzer';
import { ReflectionTrigger } from './evolution/reflection-trigger';
import { TokenBudgetAllocator } from './evolution/token-budget-allocator';
import { FileUploadHandler } from './files/file-upload-handler';
import { MediaDownloader } from './media/media-downloader';
import { MediaProcessor } from './media/media-processor';
import { MediaUnderstanding } from './media/media-understanding';
import { ConfigLoader } from './memory/config-loader';
import { ContextManager } from './memory/context-manager';
import { EntityManager } from './memory/graph/entity-manager';
import { OpenVikingClient } from './memory/openviking/openviking-client';
import type { SessionStore } from './memory/session-store';
import { UserConfigLoader } from './memory/user-config-loader';
import { OnboardingManager } from './onboarding';
import { buildMemorySnapshot } from './prompt/memory-snapshot-builder';
import { buildPrependContext } from './prompt/prepend-context-builder';
import { SystemPromptBuilder } from './prompt/system-prompt-builder';
import { buildTurnContext } from './prompt/turn-context-builder';
import { JobStore } from './scheduling/job-store';
import { nlToCron } from './scheduling/nl-to-cron';
import { ScheduleCancelManager } from './scheduling/schedule-cancel-manager';
import { Scheduler } from './scheduling/scheduler';
import {
  HarnessMutex,
  SessionManager,
  SessionSerializer,
  WorktreePool,
  generateBranchName,
} from './sessioning';
import { SkillIndexBuilder } from './skills/skill-index-builder';
import { StreamContentFilter } from './streaming/stream-content-filter';
import { StreamHandler } from './streaming/stream-handler';
import type { ChannelStreamAdapter } from './streaming/stream-protocol';
import { classifyExecutionMode } from './tasking/execution-mode-classifier';
import { QueueAggregator } from './tasking/queue-aggregator';
import { TaskQueue } from './tasking/task-queue';
import type { TaskStore } from './tasking/task-store';
import { WorkspaceManager } from './workspace';

export interface CentralControllerDeps {
  sessionManager?: SessionManager;
  agentRuntime?: AgentRuntime;
  scheduler?: Scheduler;
  taskQueue?: TaskQueue;
  classifier?: TaskClassifier;
  claudeBridge?: ClaudeAgentBridge;
  lightLLM?: LightLLMClient;
  streamHandler?: StreamHandler;
  streamCallback?: (userId: string, event: StreamEvent) => void;
  streamAdapterFactory?: (
    userId: string,
    channel: string,
    conversationId: string,
  ) => ChannelStreamAdapter[];
  ovClient?: OpenVikingClient;
  configLoader?: ConfigLoader;
  contextManager?: ContextManager;
  evolutionScheduler?: EvolutionScheduler;
  lessonsUpdater?: LessonsLearnedUpdater;
  entityManager?: EntityManager;
  knowledgeRouter?: KnowledgeRouter;
  postResponseAnalyzer?: PostResponseAnalyzer;
  workspaceManager?: WorkspaceManager;
  mediaProcessor?: MediaProcessor;
  channelResolver?: (channelType: string) => IChannel | undefined;
  sessionSerializer?: SessionSerializer;
  harnessMutex?: HarnessMutex;
  worktreePool?: WorktreePool;
  sessionStore?: SessionStore;
  taskStore?: TaskStore;
}

export class CentralController {
  private static instance: CentralController | null = null;
  private readonly sessionManager: SessionManager;
  private readonly agentRuntime: AgentRuntime;
  private readonly scheduler: Scheduler;
  private readonly scheduleCancelManager: ScheduleCancelManager;
  private readonly taskQueue: TaskQueue;
  private readonly logger: Logger;
  private readonly activeRequests: Map<string, AbortController> = new Map();
  private readonly streamHandler: StreamHandler;
  private readonly streamCallback?: (userId: string, event: StreamEvent) => void;
  private streamAdapterFactory?: (
    userId: string,
    channel: string,
    conversationId: string,
  ) => ChannelStreamAdapter[];
  private readonly ovClient: OpenVikingClient;
  private readonly configLoader: ConfigLoader;
  private readonly contextManager: ContextManager;
  private readonly knowledgeRouter: KnowledgeRouter;
  private readonly postResponseAnalyzer: PostResponseAnalyzer;
  private readonly evolutionScheduler: EvolutionScheduler;
  private readonly lessonsUpdater: LessonsLearnedUpdater;
  private readonly entityManager: EntityManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly onboardingManager: OnboardingManager;
  private readonly sessionSerializer: SessionSerializer;
  private readonly harnessMutex: HarnessMutex;
  private readonly worktreePool: WorktreePool;
  private readonly classifier: TaskClassifier;
  private readonly fileUploadHandler: FileUploadHandler;
  private readonly mediaProcessor: MediaProcessor;
  private channelResolver?: (channelType: string) => IChannel | undefined;
  private readonly sessionStore?: SessionStore;
  private readonly taskStore?: TaskStore;
  private readonly systemPromptBuilder: SystemPromptBuilder;
  private readonly intelligenceGateway?: IntelligenceGateway;
  private readonly queueAggregator: QueueAggregator;
  private readonly reflectionTrigger: ReflectionTrigger;
  private readonly frozenContextManager: FrozenContextManager;
  private readonly mcpConfigBuilder: McpConfigBuilder;
  private readonly taskGuidanceBuilder: TaskGuidanceBuilder;

  private constructor(deps?: CentralControllerDeps) {
    // Store optional persistence stores
    this.sessionStore = deps?.sessionStore;
    this.taskStore = deps?.taskStore;

    this.sessionManager =
      deps?.sessionManager ?? new SessionManager({ sessionStore: this.sessionStore });
    this.scheduler = deps?.scheduler ?? new Scheduler(new JobStore());
    this.scheduleCancelManager = new ScheduleCancelManager(this.scheduler);
    this.taskQueue = deps?.taskQueue ?? new TaskQueue();
    this.logger = new Logger('CentralController');
    this.streamHandler = deps?.streamHandler ?? new StreamHandler();
    this.streamCallback = deps?.streamCallback;
    this.streamAdapterFactory = deps?.streamAdapterFactory;

    // Build classifier and AgentRuntime with injected dependencies
    this.classifier = deps?.classifier ?? new TaskClassifier(deps?.lightLLM ?? null);
    this.agentRuntime =
      deps?.agentRuntime ??
      new AgentRuntime({
        classifier: this.classifier,
        claudeBridge: deps?.claudeBridge ?? null,
        lightLLM: deps?.lightLLM ?? null,
      });

    // OpenViking client — connects to OpenViking Server
    const ovUrl = process.env.OPENVIKING_URL ?? 'http://localhost:1933';
    this.ovClient = deps?.ovClient ?? new OpenVikingClient({ baseUrl: ovUrl });

    // ConfigLoader — loads AIEOS files (local-first, VikingFS fallback)
    this.configLoader = deps?.configLoader ?? new ConfigLoader(this.ovClient);

    // ContextManager — Pre-Compaction flush
    this.contextManager = deps?.contextManager ?? new ContextManager(this.ovClient);

    // Evolution modules
    this.evolutionScheduler = deps?.evolutionScheduler ?? new EvolutionScheduler(this.ovClient);
    this.lessonsUpdater =
      deps?.lessonsUpdater ?? new LessonsLearnedUpdater(this.ovClient, this.configLoader);
    this.entityManager = deps?.entityManager ?? new EntityManager(this.ovClient);

    // KnowledgeRouter — uses ConfigLoader + OpenViking retrieval
    const conflictResolver = new ConflictResolver();
    const tokenBudgetAllocator = new TokenBudgetAllocator();
    this.knowledgeRouter =
      deps?.knowledgeRouter ??
      new KnowledgeRouter({
        configLoader: this.configLoader,
        ovClient: this.ovClient,
        conflictResolver,
        tokenBudgetAllocator,
      });

    // PostResponseAnalyzer — uses new Lessons pipeline
    const lightLLM = deps?.lightLLM ?? null;
    this.postResponseAnalyzer =
      deps?.postResponseAnalyzer ??
      new PostResponseAnalyzer({
        lessonsUpdater: this.lessonsUpdater,
        llmCall: lightLLM
          ? async (prompt: string) => {
              const res = await lightLLM.complete({
                messages: [{ role: 'user', content: prompt }],
              });
              return res.content;
            }
          : null,
      });

    this.workspaceManager = deps?.workspaceManager ?? new WorkspaceManager();
    this.sessionSerializer = deps?.sessionSerializer ?? new SessionSerializer();
    this.harnessMutex = deps?.harnessMutex ?? new HarnessMutex();
    this.worktreePool = deps?.worktreePool ?? new WorktreePool();

    // IntelligenceGateway — Layer 1 快速预处理（DD-014）
    // 仅在 claudeBridge 和 lightLLM 都可用时启用
    if (deps?.claudeBridge && lightLLM) {
      const claudeAdapter = new ClaudeBridgeAdapter(deps.claudeBridge);
      const codexBridge = new CodexAgentBridge();
      const agentBridge = new AgentBridgeWithFallback(claudeAdapter, codexBridge);
      this.intelligenceGateway = new IntelligenceGateway(
        lightLLM as unknown as LightLlmCompletable,
        agentBridge,
      );
    }

    // OnboardingManager — guides new users through setup
    this.onboardingManager = new OnboardingManager(deps?.lightLLM ?? null);

    // FileUploadHandler — handles USER.md uploads
    this.fileUploadHandler = new FileUploadHandler();
    this.channelResolver = deps?.channelResolver;

    // SystemPromptBuilder — session-level frozen prompt (DD-018)
    this.systemPromptBuilder = new SystemPromptBuilder(deps?.configLoader ?? this.configLoader);

    // DD-013/DD-017: Auxiliary modules for queue aggregation, reflection, and frozen context
    this.queueAggregator = new QueueAggregator();
    this.reflectionTrigger = new ReflectionTrigger();
    this.frozenContextManager = new FrozenContextManager();

    // W-06/W-07: McpConfigBuilder + TaskGuidanceBuilder
    this.mcpConfigBuilder = new McpConfigBuilder();
    this.taskGuidanceBuilder = new TaskGuidanceBuilder();

    // MediaProcessor — handles image/media attachments
    this.mediaProcessor =
      deps?.mediaProcessor ??
      new MediaProcessor({
        downloader: new MediaDownloader({ channelResolver: deps?.channelResolver }),
        understanding: new MediaUnderstanding({ lightLLM: deps?.lightLLM ?? null }),
      });

    // Wire session close to worktree release + OpenViking commit + evolution scheduling
    this.sessionManager.setOnSessionClose(async (_summary, sessionId, session) => {
      // Release worktree if session was a harness session
      if (session?.harnessWorktreeSlotId) {
        try {
          await this.worktreePool.release(session.harnessWorktreeSlotId);
          this.logger.info('Harness worktree 已释放', {
            sessionId,
            slotId: session.harnessWorktreeSlotId,
          });
        } catch (err) {
          this.logger.warn('Harness worktree 释放失败', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      try {
        const commitResult = await this.ovClient.commit(sessionId);
        if (commitResult.memories_extracted > 0) {
          // Schedule evolution for newly extracted memories
          // Note: commit doesn't return URIs directly, so schedule general evolution
          this.evolutionScheduler.schedulePostCommit([]);
        }
      } catch (err) {
        this.logger.warn('会话提交失败', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // DD-012: Check if background reflection should trigger
      if (this.sessionStore && session) {
        try {
          const unreflected = this.sessionStore.getUnreflectedSessions(session.userId);
          const shouldReflect = this.reflectionTrigger.shouldReflect({
            lastReflectionAt: null, // TODO: track last reflection time per user
            unreflectedSessionCount: unreflected.length,
          });
          if (shouldReflect) {
            this.logger.info('触发后台反思', {
              userId: session.userId,
              unreflectedCount: unreflected.length,
            });
            // Fire-and-forget: spawn reflection as background task via TaskDispatcher
            // Full integration requires TaskDispatcher to be the primary dispatcher (DD-017)
          }
        } catch (err) {
          this.logger.warn('反思触发检查失败', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  }

  static getInstance(deps?: CentralControllerDeps): CentralController {
    if (!CentralController.instance) {
      CentralController.instance = new CentralController(deps);
    }
    return CentralController.instance;
  }

  static resetInstance(): void {
    CentralController.instance = null;
  }

  async handleIncomingMessage(message: BotMessage): Promise<TaskResult> {
    const traceId = generateTraceId();
    this.logger.info('消息接收', {
      traceId,
      messageId: message.id,
      channel: message.channel,
      userId: message.userId,
    });

    try {
      let session = await this.sessionManager.resolveSession(
        message.userId,
        message.channel,
        message.conversationId,
      );

      // Ensure user workspace is initialized (idempotent)
      if (!session.workspacePath) {
        const paths = this.workspaceManager.initializeWithMcp({
          userId: message.userId,
          tenantId: 'default',
          workspaceDir: '',
          userPermissions: ['*'],
          tenantConfig: {},
        });
        session.workspacePath = paths.absolutePath;
      }

      // Ensure per-user config loader
      if (!session.userConfigLoader) {
        session.userConfigLoader = new UserConfigLoader(
          message.userId,
          this.ovClient,
          this.configLoader,
          session.workspacePath!,
        );
      }

      // --- Onboarding detection ---
      // Restore onboarding state from BOOTSTRAP.md if process restarted
      await this.onboardingManager.tryRestoreState(message.userId, session.userConfigLoader!);

      // User currently in onboarding?
      if (this.onboardingManager.isOnboarding(message.userId)) {
        const reply = await this.onboardingManager.processResponse(
          message.userId,
          message.content,
          session.userConfigLoader!,
        );
        return {
          success: true,
          taskId: generateTaskId(),
          data: { content: reply, channel: message.channel },
          completedAt: Date.now(),
        };
      }

      // First-time user? Start onboarding
      if (await this.onboardingManager.needsOnboarding(session.userConfigLoader!)) {
        const reply = await this.onboardingManager.startOnboarding(
          message.userId,
          session.userConfigLoader!,
        );
        return {
          success: true,
          taskId: generateTaskId(),
          data: { content: reply, channel: message.channel },
          completedAt: Date.now(),
        };
      }

      // TODO DD-017: Use queueAggregator to merge pending messages before task execution.
      // When TaskDispatcher replaces direct orchestrate() calls, aggregate queued messages here:
      // const pending = this.taskQueue.getPending(sessionKey);
      // if (pending.length > 1) { const aggregated = await this.queueAggregator.aggregate(pending); }

      // --- File upload detection ---
      if (
        message.contentType === 'file' &&
        message.metadata.fileName &&
        this.fileUploadHandler.isUserProfileUpload(message.metadata.fileName as string)
      ) {
        const reply = await this.handleUserMdUpload(message, session.userConfigLoader!);
        return {
          success: true,
          taskId: generateTaskId(),
          data: { content: reply, channel: message.channel },
          completedAt: Date.now(),
        };
      }

      // --- Harness end detection ---
      const HARNESS_END_PATTERN = /^(结束(任务)?|\/end)\s*$/i;
      if (session.harnessWorktreeSlotId && HARNESS_END_PATTERN.test(message.content.trim())) {
        const sessionKey = `${message.userId}:${message.channel}:${message.conversationId}`;
        return this.handleHarnessEnd(message, session, sessionKey);
      }

      // --- Schedule cancel selection detection ---
      if (this.scheduleCancelManager.isPendingSelection(message.userId)) {
        const result = this.scheduleCancelManager.processSelection(message.userId, message.content);
        return {
          success: true,
          taskId: generateTaskId(),
          data: {
            content: (result.data as { content: string })?.content ?? result.error,
            channel: message.channel,
          },
          completedAt: Date.now(),
        };
      }

      // --- Harness follow-up detection ---
      // If session already has a bound worktree, force harness classification
      let classifyResult: UnifiedClassifyResult;
      if (session.harnessWorktreeSlotId) {
        classifyResult = {
          taskType: 'harness',
          complexity: 'complex',
          reason: '会话已绑定 worktree，继续 harness 模式',
          confidence: 1.0,
          classifiedBy: 'rule',
          costUsd: 0,
        };
      } else {
        classifyResult = await this.classifyIntent(message);
      }

      // --- Harness group chat creation (feishu only) ---
      if (classifyResult.taskType === 'harness' && !isAdminUser(message.userId)) {
        this.logger.warn('非管理员用户触发 harness，降级为普通对话', {
          userId: message.userId,
        });
      }
      if (
        classifyResult.taskType === 'harness' &&
        isAdminUser(message.userId) &&
        !session.harnessWorktreeSlotId
      ) {
        const groupChatId = await this.maybeCreateHarnessGroupChat(message);
        if (groupChatId) {
          const originalSession = session;
          message.conversationId = groupChatId;
          // Re-resolve session with new conversationId (group chat)
          session = await this.sessionManager.resolveSession(
            message.userId,
            message.channel,
            groupChatId,
          );
          session.harnessGroupChatId = groupChatId;
          // Carry over workspace and config from original session
          if (!session.workspacePath) session.workspacePath = originalSession.workspacePath;
          if (!session.userConfigLoader)
            session.userConfigLoader = originalSession.userConfigLoader;
        }
      }

      const taskType = classifyResult.taskType;

      const task: Task = {
        id: generateTaskId(),
        traceId,
        type: taskType,
        message,
        session,
        priority: this.calculatePriority(taskType),
        createdAt: Date.now(),
        metadata: {
          userId: message.userId,
          channel: message.channel,
          conversationId: message.conversationId,
        },
        classifyResult,
      };

      this.logger.info('任务创建', {
        traceId,
        taskId: task.id,
        type: taskType,
        priority: task.priority,
        classifiedBy: classifyResult.classifiedBy,
        reason: classifyResult.reason,
        complexity: classifyResult.complexity,
      });

      const abortController = new AbortController();
      this.activeRequests.set(task.id, abortController);
      task.signal = abortController.signal;

      try {
        const sessionKey = `${message.userId}:${message.channel}:${message.conversationId}`;
        const result = await this.sessionSerializer.run(sessionKey, () => this.orchestrate(task));
        return result;
      } finally {
        this.activeRequests.delete(task.id);
      }
    } catch (error) {
      this.logger.error('消息处理失败', {
        traceId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof YourBotError
        ? error
        : new YourBotError(ERROR_CODES.UNKNOWN, '消息处理失败', {
            messageId: message.id,
            originalError: error instanceof Error ? error.message : String(error),
          });
    }
  }

  async orchestrate(task: Task): Promise<TaskResult> {
    this.logger.info('任务编排', {
      traceId: task.traceId,
      taskId: task.id,
      type: task.type,
    });

    switch (task.type) {
      case 'chat':
        return this.handleChatTask(task);
      case 'scheduled':
        return this.handleScheduledTask(task);
      case 'automation':
        return this.handleAutomationTask(task);
      case 'system':
        return this.handleSystemTask(task);
      case 'harness':
        return this.handleHarnessTask(task);
    }
  }

  async classifyIntent(message: BotMessage): Promise<UnifiedClassifyResult> {
    const result = await this.classifier.classify(message.content, { userId: message.userId });

    // DD-014: Enrich with execution mode classification
    const executionMode = classifyExecutionMode({
      taskType: result.taskType,
      complexity: result.complexity,
      source: 'user',
      content: message.content,
    });
    result.executionMode = executionMode;

    return result;
  }

  calculatePriority(taskType: TaskType): number {
    const BASE_PRIORITIES: Record<TaskType, number> = {
      system: 1,
      harness: 2,
      chat: 5,
      scheduled: 10,
      automation: 15,
    };
    return BASE_PRIORITIES[taskType];
  }

  private async handleChatTask(task: Task): Promise<TaskResult> {
    return this.executeChatPipeline(task);
  }

  private async handleHarnessTask(task: Task): Promise<TaskResult> {
    if (!isAdminUser(task.message.userId)) {
      // Non-admin: silently downgrade to chat
      task.type = 'chat';
      return this.executeChatPipeline(task);
    }

    const session = task.session;

    // Follow-up: session already has worktree
    if (session.harnessWorktreeSlotId && session.harnessWorktreePath) {
      this.logger.info('Harness 后续消息复用 worktree', {
        taskId: task.id,
        slotId: session.harnessWorktreeSlotId,
        worktreePath: session.harnessWorktreePath,
      });
      return this.executeChatPipeline(task, {
        cwdOverride: session.harnessWorktreePath,
        forceComplex: true,
      });
    }

    // First message: acquire worktree and bind to session
    const branchName = generateBranchName(task.message.content);
    const slot = await this.worktreePool.acquire(task.id, branchName);
    session.harnessWorktreeSlotId = slot.id;
    session.harnessWorktreePath = slot.worktreePath;
    session.harnessBranch = slot.branch;

    this.logger.info('Harness 首次消息分配 worktree', {
      taskId: task.id,
      branch: slot.branch,
      worktreePath: slot.worktreePath,
    });

    return this.executeChatPipeline(task, {
      cwdOverride: slot.worktreePath,
      forceComplex: true,
    });
  }

  private async handleHarnessEnd(
    message: BotMessage,
    session: Session,
    sessionKey: string,
  ): Promise<TaskResult> {
    const branch = session.harnessBranch ?? '(unknown)';
    const messageCount = session.messages.length;
    const durationMs = Date.now() - session.createdAt;
    const durationMin = Math.round(durationMs / 60000);

    const summary = [
      '🏁 Harness 任务结束',
      `- 分支: \`${branch}\``,
      `- 消息数: ${messageCount}`,
      `- 时长: ${durationMin} 分钟`,
    ].join('\n');

    this.logger.info('Harness 任务结束', {
      sessionKey,
      branch,
      messageCount,
      durationMin,
    });

    await this.sessionManager.closeSession(sessionKey);

    return {
      success: true,
      taskId: generateTaskId(),
      data: { content: summary, channel: message.channel },
      completedAt: Date.now(),
    };
  }

  /**
   * For feishu harness commands, create a group chat and return its chatId.
   * Returns null if not applicable (non-feishu channel or no channel resolver).
   */
  private async maybeCreateHarnessGroupChat(message: BotMessage): Promise<string | null> {
    if (message.channel !== 'feishu' || !this.channelResolver) return null;
    const channel = this.channelResolver('feishu');
    if (!channel?.createGroupChat) return null;

    const taskDesc = message.content.replace(/^\/harness\s*/i, '').slice(0, 40);

    let groupChatId: string;
    try {
      groupChatId = await channel.createGroupChat(message.userId, `Harness: ${taskDesc}`);
    } catch (error) {
      this.logger.error('Harness 群聊创建失败，继续使用当前会话', {
        userId: message.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    await channel.sendMessage(message.userId, {
      type: 'text',
      text: 'Harness 会话已创建群聊，请在群聊中继续交互。',
    });

    return groupChatId;
  }

  private async executeChatPipeline(
    task: Task,
    options?: { cwdOverride?: string; forceComplex?: boolean },
  ): Promise<TaskResult> {
    this.logger.info('处理聊天任务', { traceId: task.traceId, taskId: task.id });

    const sessionKey = `${task.message.userId}:${task.message.channel}:${task.message.conversationId}`;

    // --- Media processing ---
    let mediaRefs: MediaRef[] | undefined;
    if (task.message.attachments?.length) {
      try {
        const processed = await this.mediaProcessor.processAttachments(task.message.attachments, {
          runUnderstanding: true,
        });
        mediaRefs = processed
          .filter((a) => a.state === 'processed' || a.state === 'downloaded')
          .map((a) => this.mediaProcessor.toMediaRef(a));
      } catch (error) {
        this.logger.warn('媒体处理失败，继续纯文本处理', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Append descriptions to text content (for session storage and Claude CLI path)
    let sessionContent = task.message.content;
    if (mediaRefs?.length) {
      const descriptions = mediaRefs.map((r) => `[图片: ${r.description}]`).join('\n');
      sessionContent = sessionContent ? `${sessionContent}\n${descriptions}` : descriptions;
    }

    // Add user message to session history
    this.sessionManager.addMessage(sessionKey, {
      role: 'user',
      content: sessionContent,
      timestamp: task.message.timestamp,
      mediaRefs,
    });

    // Also sync to OpenViking session
    try {
      await this.ovClient.addMessage(task.session.id, 'user', sessionContent);
    } catch {
      // Non-critical, continue
    }

    // Build stream callback with StreamContentFilter
    // Filter: only pass text_delta, tool_use, error, done events; block thinking/tool_result
    const streamFilter = new StreamContentFilter();
    let streamCallback: ((event: StreamEvent) => void) | undefined;
    let streamResultPromise: Promise<unknown> | undefined;

    const adapters = this.streamAdapterFactory?.(
      task.message.userId,
      task.message.channel,
      task.message.conversationId,
    );

    if (adapters && adapters.length > 0) {
      const stream = this.streamHandler.createStreamCallback(adapters);
      const rawCallback = stream.callback;
      streamCallback = (event: StreamEvent) => {
        const filtered = streamFilter.filter(event);
        if (filtered) {
          rawCallback(event); // Pass original event (adapter handles formatting)
        }
      };
      streamResultPromise = stream.result;
    } else if (this.streamCallback) {
      const rawUserCallback = this.streamCallback;
      const userId = task.message.userId;
      streamCallback = (event: StreamEvent) => {
        const filtered = streamFilter.filter(event);
        if (filtered) {
          rawUserCallback(userId, event);
        }
      };
    }

    // Load AIEOS config + retrieve memories via OpenViking
    const { summaries, messages: contextMessages } =
      this.sessionManager.getContextMessages(sessionKey);

    // Pre-Compaction check
    const estimatedTokens = contextMessages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0,
    );
    const anchor = await this.contextManager.checkAndFlush(task.session.id, estimatedTokens);

    // DEPRECATED: Build knowledge-routed system prompt (kept as fallback)
    // const resolvedContext = await this.knowledgeRouter.buildContext(
    //   task.message.userId,
    //   task.message.content,
    //   contextMessages,
    //   'complex',
    //   {
    //     summaries,
    //     workspaceInfo: this.getWorkspaceInfo(),
    //     anchorText: anchor ?? undefined,
    //     configLoader: task.session.userConfigLoader,
    //   },
    // );

    // ── DD-018: Session-level frozen prompt + per-turn context ──
    // Build frozen system prompt once per session (or rebuild after compaction)
    let systemPromptFallback: string | undefined;
    if (!task.session.frozenSystemPrompt) {
      try {
        // W-03: Build skill index from real SkillIndexBuilder
        const skillIndexBuilder = new SkillIndexBuilder();
        const workspaceInfo = this.getWorkspaceInfo();
        const skillIndex = skillIndexBuilder.build({
          skills: workspaceInfo.availableSkills.map((name) => ({
            name,
            description: name,
            dir: `skills/builtin/${name}`,
          })),
          channel: task.session.channel,
        });

        // W-04: Build memory snapshot from real builder (empty data until OpenViking integration)
        const memorySnapshot = buildMemorySnapshot([]);

        const frozen = await this.systemPromptBuilder.build({
          userId: task.session.userId,
          channel: task.session.channel,
          workspacePath: task.session.workspacePath,
          skillIndex,
          memorySnapshot,
        });
        task.session.frozenSystemPrompt = {
          ...frozen,
          sections: frozen.sections as unknown as Record<string, string>,
        };

        // Build prepend context (first user message, OVERRIDE semantics)
        const userConfig = (await task.session.userConfigLoader?.loadFile?.('USER.md')) || '';
        const agentsConfig = (await task.session.userConfigLoader?.loadFile?.('AGENTS.md')) || '';
        task.session.prependContext = buildPrependContext({
          agentsConfig,
          userConfig,
        });
      } catch (err) {
        this.logger.warn('SystemPromptBuilder 失败，回退到 KnowledgeRouter', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fallback to KnowledgeRouter
        const resolvedContext = await this.knowledgeRouter.buildContext(
          task.message.userId,
          task.message.content,
          contextMessages,
          'complex',
          {
            summaries,
            workspaceInfo: this.getWorkspaceInfo(),
            anchorText: anchor ?? undefined,
            configLoader: task.session.userConfigLoader,
          },
        );
        systemPromptFallback = resolvedContext.systemPrompt;
      }
    }

    // Per-turn context injection
    const taskGuidance = this.taskGuidanceBuilder.build({
      taskType: task.classifyResult?.taskType || 'chat',
      executionMode: task.classifyResult?.executionMode || 'sync',
      workspacePath: task.session.workspacePath,
    });
    const turnContext = buildTurnContext({
      memories: await this.retrieveRelevantMemories(task.message.content, task.session.userId),
      taskType: task.classifyResult?.taskType || 'chat',
      executionMode: task.classifyResult?.executionMode || 'sync',
      taskGuidance,
      invokedSkills: task.session.invokedSkills ? [...task.session.invokedSkills] : undefined,
      postCompaction: task.session.postCompaction,
      mcpServers:
        task.session.activeMcpServers || task.session.previousMcpServers
          ? {
              current: task.session.activeMcpServers ? [...task.session.activeMcpServers] : [],
              previous: task.session.previousMcpServers ? [...task.session.previousMcpServers] : [],
            }
          : undefined,
    });

    // Assemble final system prompt: frozen prompt (or fallback) + turn context
    const isFirstMessage = task.session.messages.length <= 1;
    const frozenContent = task.session.frozenSystemPrompt?.content ?? systemPromptFallback ?? '';
    const prependBlock =
      isFirstMessage && task.session.prependContext ? `${task.session.prependContext}\n\n` : '';
    const finalSystemPrompt =
      frozenContent +
      (turnContext.content
        ? `\n\n${prependBlock}${turnContext.content}`
        : prependBlock
          ? `\n\n${prependBlock}`
          : '');

    const workspacePath = options?.cwdOverride ?? task.session.workspacePath;

    // Assemble prependContext for gateway (first message only)
    const prependContext =
      isFirstMessage && task.session.prependContext ? task.session.prependContext : '';

    // Execute via IntelligenceGateway (with AgentRuntime fallback)
    let result: EnhancedAgentResult;

    if (this.intelligenceGateway) {
      try {
        const gatewayResult = await this.intelligenceGateway.handle({
          message: task.message.content,
          complexity: task.classifyResult?.complexity || 'complex',
          taskType: task.classifyResult?.taskType || 'chat',
          hasAttachments: (task.message.attachments?.length ?? 0) > 0,
          agentParams: {
            systemPrompt: finalSystemPrompt,
            prependContext,
            userMessage: task.message.content,
            sessionId: task.session.id,
            claudeSessionId: task.session.claudeSessionId,
            workspacePath,
            mcpConfig: this.mcpConfigBuilder.build({
              executionMode: task.classifyResult?.executionMode || 'sync',
              taskType: task.classifyResult?.taskType || 'chat',
              userId: task.session.userId,
            }),
            signal: task.signal,
            streamCallback: streamCallback
              ? async (event) => {
                  streamCallback(event);
                }
              : undefined,
            executionMode: task.classifyResult?.executionMode || 'sync',
            classifyResult: task.classifyResult as Record<string, unknown> | undefined,
            maxTurns: task.classifyResult?.taskType === 'harness' ? 100 : 30,
          },
        });

        // Map to EnhancedAgentResult for backward compatibility
        result = {
          content: gatewayResult.content,
          tokenUsage: gatewayResult.tokenUsage,
          toolsUsed: gatewayResult.toolsUsed,
          claudeSessionId: gatewayResult.claudeSessionId,
          complexity: gatewayResult.handledBy === 'gateway' ? 'simple' : 'complex',
          channel: gatewayResult.handledBy === 'gateway' ? 'light_llm' : 'agent_sdk',
          classificationCostUsd: task.classifyResult?.costUsd ?? 0,
        };
      } catch (gatewayError) {
        this.logger.warn('IntelligenceGateway 失败，回退到 AgentRuntime', {
          error: gatewayError instanceof Error ? gatewayError.message : String(gatewayError),
        });
        result = await this.agentRuntime.execute({
          agentId: 'default',
          context: {
            sessionId: task.session.id,
            messages: contextMessages,
            systemPrompt: finalSystemPrompt,
            workspacePath,
            claudeSessionId: task.session.claudeSessionId,
          },
          signal: task.signal,
          streamCallback,
          forceComplex: options?.forceComplex,
          classifyResult: task.classifyResult,
        });
      }
    } else {
      // No gateway available — use AgentRuntime directly
      result = await this.agentRuntime.execute({
        agentId: 'default',
        context: {
          sessionId: task.session.id,
          messages: contextMessages,
          systemPrompt: finalSystemPrompt,
          workspacePath,
          claudeSessionId: task.session.claudeSessionId,
        },
        signal: task.signal,
        streamCallback,
        forceComplex: options?.forceComplex,
        classifyResult: task.classifyResult,
      });
    }

    if (streamResultPromise) {
      await streamResultPromise;
    }

    // Clear base64 data from mediaRefs to prevent memory bloat in session history
    if (mediaRefs?.length) {
      for (const ref of mediaRefs) {
        ref.base64Data = undefined;
      }
    }

    if (result.toolsUsed && result.toolsUsed.length > 0) {
      this.sessionManager.markToolUsed(sessionKey);
    }
    if (result.claudeSessionId) {
      task.session.claudeSessionId = result.claudeSessionId;
    }

    // Post-response analysis: detect corrections → lessons
    let responseContent = result.content;
    const feedbackText = await this.postResponseAnalyzer.analyzeExchange(
      task.message.userId,
      task.message.content,
      result.content,
      contextMessages,
      task.session.userConfigLoader,
    );
    if (feedbackText) {
      responseContent += `\n\n---\n${feedbackText}`;
    }

    // DD-012: Route analysis results via AnalysisRouter
    if (feedbackText) {
      const items: AnalysisItem[] = [{ content: feedbackText, type: 'lesson' }];
      const routed = routeAnalysis(items);

      if (routed.memories.length > 0) {
        this.logger.debug('分析结果路由到 Memory', { count: routed.memories.length });
      }
      if (routed.skillCandidates.length > 0) {
        this.logger.debug('分析结果路由到 Skill', { count: routed.skillCandidates.length });
        // TODO: actual skill creation via skill_manage when structured output available
      }
    }

    // Sync assistant message to OpenViking session
    try {
      await this.ovClient.addMessage(task.session.id, 'assistant', responseContent);
    } catch {
      // Non-critical
    }

    // Add assistant message to session history
    this.sessionManager.addMessage(sessionKey, {
      role: 'assistant',
      content: responseContent,
      timestamp: Date.now(),
    });

    return {
      success: true,
      taskId: task.id,
      data: {
        content: responseContent,
        tokenUsage: result.tokenUsage,
        complexity: result.complexity,
        channel: result.channel,
        ...(adapters && adapters.length > 0 ? { streamed: true } : {}),
      },
      completedAt: Date.now(),
    };
  }

  private async handleScheduledTask(task: Task): Promise<TaskResult> {
    this.logger.info('处理定时任务', { traceId: task.traceId, taskId: task.id });

    const subIntent = task.classifyResult?.subIntent;

    if (subIntent === 'cancel') {
      return this.scheduleCancelManager.startCancelFlow(task.message.userId);
    }

    if (subIntent === 'list') {
      return this.handleListScheduledTasks(task.message.userId);
    }

    // Default: create flow
    const nlResult = nlToCron(task.message.content);

    // Bug 2: cron 解析失败时拦截，不注册无效 job
    if (!nlResult.cron || nlResult.confidence === 0) {
      return {
        success: false,
        taskId: task.id,
        error: `无法识别调度模式: ${nlResult.description}`,
        completedAt: Date.now(),
      };
    }

    const jobId = await this.scheduler.register({
      cronExpression: nlResult.cron,
      taskTemplate: {
        messageContent: nlResult.taskContent,
        userName: task.message.userName,
        conversationId: task.message.conversationId,
      },
      userId: task.message.userId,
      description: task.message.content,
      channel: task.message.channel,
    });

    return {
      success: true,
      taskId: task.id,
      data: {
        type: 'scheduled_registered',
        jobId,
        cronExpression: nlResult.cron,
        cronDescription: nlResult.description,
        confidence: nlResult.confidence,
      },
      completedAt: Date.now(),
    };
  }

  private handleListScheduledTasks(userId: string): TaskResult {
    const activeJobs = this.scheduler
      .listJobs(userId)
      .filter((j) => j.status === 'active' || j.status === 'paused');

    if (activeJobs.length === 0) {
      return {
        success: true,
        taskId: generateTaskId(),
        data: { content: '你目前没有活跃的定时任务。' },
        completedAt: Date.now(),
      };
    }

    const lines = ['你当前的定时任务：', ''];
    for (const [i, job] of activeJobs.entries()) {
      const nextRun = new Date(job.nextRunAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      });
      lines.push(`${i + 1}. ${job.description}`);
      lines.push(`   下次执行: ${nextRun}`);
    }

    return {
      success: true,
      taskId: generateTaskId(),
      data: { content: lines.join('\n') },
      completedAt: Date.now(),
    };
  }

  private async handleAutomationTask(task: Task): Promise<TaskResult> {
    this.logger.info('处理自动化任务', { traceId: task.traceId, taskId: task.id });
    return this.taskQueue.enqueue(task);
  }

  private async handleSystemTask(task: Task): Promise<TaskResult> {
    this.logger.info('处理系统任务', { traceId: task.traceId, taskId: task.id });
    const command = task.message.content.slice(1).trim().split(' ')[0];

    switch (command) {
      case 'setup': {
        // Force restart onboarding
        this.onboardingManager.resetUser(task.message.userId);
        const reply = await this.onboardingManager.startOnboarding(
          task.message.userId,
          task.session.userConfigLoader!,
        );
        return {
          success: true,
          taskId: task.id,
          data: { content: reply, channel: task.message.channel },
          completedAt: Date.now(),
        };
      }
      default:
        return {
          success: true,
          taskId: task.id,
          data: { command, response: `系统命令 '${command}' 已确认（骨架）` },
          completedAt: Date.now(),
        };
    }
  }

  private async handleUserMdUpload(
    message: BotMessage,
    userConfigLoader: UserConfigLoader,
  ): Promise<string> {
    try {
      let buffer: Buffer;

      // Web channel: base64 in metadata
      if (message.metadata.fileContentBase64) {
        buffer = Buffer.from(message.metadata.fileContentBase64 as string, 'base64');
      } else if (message.metadata.fileKey && this.channelResolver) {
        // Feishu channel: download via channel API
        const channel = this.channelResolver(message.channel);
        if (channel?.downloadFile) {
          buffer = await channel.downloadFile(message.id, message.metadata.fileKey as string);
        } else {
          return '当前通道不支持文件下载，请直接发送文件内容。';
        }
      } else {
        return '无法获取文件内容，请重试。';
      }

      return this.fileUploadHandler.processUserMdUpload(
        buffer,
        message.metadata.fileName as string,
        userConfigLoader,
      );
    } catch (err) {
      this.logger.error('USER.md 上传处理失败', {
        error: err instanceof Error ? err.message : String(err),
      });
      return '文件处理失败，请稍后重试。';
    }
  }

  private getWorkspaceInfo(): { availableSkills: string[]; recentToolsUsed: string[] } {
    const skills: string[] = [];
    try {
      const { readdirSync } = require('node:fs');
      const entries = readdirSync('skills/builtin', { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          skills.push(entry.name);
        }
      }
    } catch {
      // skills directory may not exist
    }
    return { availableSkills: skills, recentToolsUsed: [] };
  }

  /**
   * W-05: Retrieve relevant memories for per-turn context injection.
   * Graceful degradation: returns empty array if OpenViking is unavailable.
   */
  private async retrieveRelevantMemories(
    query: string,
    userId: string,
  ): Promise<Array<{ content: string; updatedAt: number }>> {
    if (!this.ovClient) return [];
    try {
      const results = await this.ovClient.find({
        query,
        target_uri: `viking://user/${userId}/memories`,
        limit: 5,
      });
      return (results || []).map((r) => ({
        content: r.abstract || String(r),
        updatedAt: Date.now(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Aggregate multiple pending messages before execution.
   * Delegates to QueueAggregator for rule-based merging.
   * Full queue integration requires TaskDispatcher to replace TaskQueue (DD-017).
   */
  async aggregateMessages(
    messages: string[],
    llmFallback?: (prompt: string) => Promise<string>,
  ): Promise<import('./tasking/queue-aggregator').AggregationResult> {
    return this.queueAggregator.aggregate(messages, llmFallback);
  }

  cancelRequest(taskId: string): boolean {
    const controller = this.activeRequests.get(taskId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(taskId);
      this.logger.info('请求已取消', { taskId });
      return true;
    }
    return false;
  }

  getActiveRequestCount(): number {
    return this.activeRequests.size;
  }

  /** Set channel resolver (called after ChannelManager is created) */
  setChannelResolver(resolver: (channelType: string) => IChannel | undefined): void {
    this.channelResolver = resolver;
  }

  /** Set stream adapter factory (called after channel registration) */
  setStreamAdapterFactory(
    factory: (userId: string, channel: string, conversationId: string) => ChannelStreamAdapter[],
  ): void {
    this.streamAdapterFactory = factory;
  }

  /**
   * Initialize the scheduler: load persisted jobs, wire executor, start timers.
   * Must be called after setChannelResolver().
   */
  async initScheduler(): Promise<void> {
    await this.scheduler.loadJobs();

    this.scheduler.setExecutor(async (job) => {
      const content = (job.taskTemplate.messageContent as string) ?? job.description;
      const userName = (job.taskTemplate.userName as string) ?? 'scheduler';
      const conversationId = (job.taskTemplate.conversationId as string) ?? `sched_${job.id}`;

      const message: BotMessage = {
        id: generateTaskId(),
        channel: job.channel,
        userId: job.userId,
        userName,
        conversationId,
        content,
        contentType: 'text',
        timestamp: Date.now(),
        metadata: { isScheduledExecution: true, jobId: job.id },
      };

      const session = await this.sessionManager.resolveSession(
        message.userId,
        message.channel,
        message.conversationId,
      );

      // Ensure workspace + config loader
      if (!session.workspacePath) {
        const paths = this.workspaceManager.initializeWithMcp({
          userId: message.userId,
          tenantId: 'default',
          workspaceDir: '',
          userPermissions: ['*'],
          tenantConfig: {},
        });
        session.workspacePath = paths.absolutePath;
      }
      if (!session.userConfigLoader) {
        session.userConfigLoader = new UserConfigLoader(
          message.userId,
          this.ovClient,
          this.configLoader,
          session.workspacePath!,
        );
      }

      const task: Task = {
        id: generateTaskId(),
        traceId: generateTraceId(),
        type: 'chat',
        message,
        session,
        priority: this.calculatePriority('chat'),
        createdAt: Date.now(),
        metadata: {
          userId: message.userId,
          channel: message.channel,
          conversationId: message.conversationId,
          isScheduledExecution: true,
        },
      };

      const result = await this.executeChatPipeline(task);

      // Push reply to user via channel
      const responseText = (result.data as Record<string, unknown>)?.content as string | undefined;
      if (responseText && this.channelResolver) {
        const ch = this.channelResolver(job.channel);
        if (ch) {
          try {
            await ch.sendMessage(job.userId, { type: 'text', text: responseText });
          } catch (err) {
            this.logger.error('定时任务推送失败', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      return result;
    });

    this.scheduler.start();
    this.logger.info('Scheduler 已初始化并启动');
  }

  /**
   * Stop the scheduler and persist jobs.
   */
  stopScheduler(): void {
    this.scheduler.stop();
    this.scheduler.persistJobs();
    this.logger.info('Scheduler 已停止并持久化');
  }
}
