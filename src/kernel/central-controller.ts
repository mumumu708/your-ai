import { LessonsLearnedUpdater } from '../lessons/lessons-updater';
import type { UnifiedClassifyResult } from '../shared/classifier/classifier-types';
import { ERROR_CODES } from '../shared/errors/error-codes';
import { YourBotError } from '../shared/errors/yourbot-error';
import { Logger } from '../shared/logging/logger';
import type { BotMessage } from '../shared/messaging/bot-message.types';
import type { IChannel } from '../shared/messaging/channel-adapter.types';
import type { StreamEvent } from '../shared/messaging/stream-event.types';
import type { TaskResult } from '../shared/tasking/task-result.types';
import type { Task, TaskType } from '../shared/tasking/task.types';
import { isAdminUser } from '../shared/utils/admin';
import { generateTaskId, generateTraceId } from '../shared/utils/crypto';
import { AgentRuntime } from './agents/agent-runtime';
import type { ClaudeAgentBridge } from './agents/claude-agent-bridge';
import type { LightLLMClient } from './agents/light-llm-client';
import { TaskClassifier } from './classifier/task-classifier';
import { ConflictResolver } from './evolution/conflict-resolver';
import { EvolutionScheduler } from './evolution/evolution-scheduler';
import { KnowledgeRouter } from './evolution/knowledge-router';
import { PostResponseAnalyzer } from './evolution/post-response-analyzer';
import { TokenBudgetAllocator } from './evolution/token-budget-allocator';
import { FileUploadHandler } from './files/file-upload-handler';
import { ConfigLoader } from './memory/config-loader';
import { ContextManager } from './memory/context-manager';
import { EntityManager } from './memory/graph/entity-manager';
import { OpenVikingClient } from './memory/openviking/openviking-client';
import { UserConfigLoader } from './memory/user-config-loader';
import { OnboardingManager } from './onboarding';
import { JobStore } from './scheduling/job-store';
import { nlToCron } from './scheduling/nl-to-cron';
import { Scheduler } from './scheduling/scheduler';
import { HarnessMutex, SessionManager, SessionSerializer } from './sessioning';
import { StreamHandler } from './streaming/stream-handler';
import type { ChannelStreamAdapter } from './streaming/stream-protocol';
import { TaskQueue } from './tasking/task-queue';
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
  channelResolver?: (channelType: string) => IChannel | undefined;
  sessionSerializer?: SessionSerializer;
  harnessMutex?: HarnessMutex;
}

export class CentralController {
  private static instance: CentralController | null = null;
  private readonly sessionManager: SessionManager;
  private readonly agentRuntime: AgentRuntime;
  private readonly scheduler: Scheduler;
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
  private readonly classifier: TaskClassifier;
  private readonly fileUploadHandler: FileUploadHandler;
  private channelResolver?: (channelType: string) => IChannel | undefined;

  private constructor(deps?: CentralControllerDeps) {
    this.sessionManager = deps?.sessionManager ?? new SessionManager();
    this.scheduler = deps?.scheduler ?? new Scheduler(new JobStore());
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

    // OnboardingManager — guides new users through setup
    this.onboardingManager = new OnboardingManager(deps?.lightLLM ?? null);

    // FileUploadHandler — handles USER.md uploads
    this.fileUploadHandler = new FileUploadHandler();
    this.channelResolver = deps?.channelResolver;

    // Wire session close to OpenViking commit + evolution scheduling
    this.sessionManager.setOnSessionClose(async (_summary, sessionId) => {
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
      const session = await this.sessionManager.resolveSession(
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

      const classifyResult = await this.classifyIntent(message);
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
        let result: TaskResult;
        if (taskType === 'harness') {
          result = await this.harnessMutex.run(() =>
            this.sessionSerializer.run(sessionKey, () => this.orchestrate(task)),
          );
        } else {
          result = await this.sessionSerializer.run(sessionKey, () => this.orchestrate(task));
        }
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
    return this.classifier.classify(message.content, { userId: message.userId });
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
    // Admin: use project root as cwd, force Claude path for tool access
    return this.executeChatPipeline(task, { cwdOverride: process.cwd(), forceComplex: true });
  }

  private async executeChatPipeline(
    task: Task,
    options?: { cwdOverride?: string; forceComplex?: boolean },
  ): Promise<TaskResult> {
    this.logger.info('处理聊天任务', { traceId: task.traceId, taskId: task.id });

    const sessionKey = `${task.message.userId}:${task.message.channel}:${task.message.conversationId}`;

    // Add user message to session history
    this.sessionManager.addMessage(sessionKey, {
      role: 'user',
      content: task.message.content,
      timestamp: task.message.timestamp,
    });

    // Also sync to OpenViking session
    try {
      await this.ovClient.addMessage(task.session.id, 'user', task.message.content);
    } catch {
      // Non-critical, continue
    }

    // Build stream callback
    let streamCallback: ((event: StreamEvent) => void) | undefined;
    let streamResultPromise: Promise<unknown> | undefined;

    const adapters = this.streamAdapterFactory?.(
      task.message.userId,
      task.message.channel,
      task.message.conversationId,
    );

    if (adapters && adapters.length > 0) {
      const stream = this.streamHandler.createStreamCallback(adapters);
      streamCallback = stream.callback;
      streamResultPromise = stream.result;
    } else if (this.streamCallback) {
      streamCallback = (event: StreamEvent) => this.streamCallback?.(task.message.userId, event);
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

    // Build knowledge-routed system prompt
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

    const workspacePath = options?.cwdOverride ?? task.session.workspacePath;

    // Execute via AgentRuntime
    const result = await this.agentRuntime.execute({
      agentId: 'default',
      context: {
        sessionId: task.session.id,
        messages: contextMessages,
        systemPrompt: resolvedContext.systemPrompt,
        workspacePath,
        claudeSessionId: task.session.claudeSessionId,
      },
      signal: task.signal,
      streamCallback,
      forceComplex: options?.forceComplex,
      classifyResult: task.classifyResult,
    });

    if (streamResultPromise) {
      await streamResultPromise;
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

    const nlResult = nlToCron(task.message.content);

    const jobId = await this.scheduler.register({
      cronExpression: nlResult.cron ?? '',
      taskTemplate: {
        messageContent: task.message.content,
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
