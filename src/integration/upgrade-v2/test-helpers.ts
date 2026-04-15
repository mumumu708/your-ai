/**
 * Shared test helpers for DD-020 architecture upgrade integration tests.
 *
 * Provides factory functions for creating:
 * - BotMessage instances
 * - Mock dependencies (LLM, OV, channels, etc.)
 * - CentralController with full mock wiring
 * - SQLite :memory: database for SessionStore/TaskStore
 */
import { Database } from 'bun:sqlite';
import { mock } from 'bun:test';
import type { AgentBridge } from '../../kernel/agents/agent-bridge';
import type { LightLLMClient } from '../../kernel/agents/light-llm-client';
import type { CentralControllerDeps } from '../../kernel/central-controller';
import { CentralController } from '../../kernel/central-controller';
import type { EvolutionScheduler } from '../../kernel/evolution/evolution-scheduler';
import type { KnowledgeRouter } from '../../kernel/evolution/knowledge-router';
import type { LessonsLearnedUpdater } from '../../kernel/evolution/learning/lessons-updater';
import type { PostResponseAnalyzer } from '../../kernel/evolution/learning/post-response-analyzer';
import type { MediaProcessor } from '../../kernel/media/media-processor';
import type { ContextManager } from '../../kernel/memory/context-manager';
import type { EntityManager } from '../../kernel/memory/graph/entity-manager';
import type { OpenVikingClient } from '../../kernel/memory/openviking/openviking-client';
import { SessionStore } from '../../kernel/memory/session-store';
import type { ConfigLoader } from '../../kernel/prompt/config-loader';
import type { WorktreePool } from '../../kernel/sessioning';
import type { ChannelStreamAdapter } from '../../kernel/streaming/stream-protocol';
import { TaskStore } from '../../kernel/tasking/task-store';
import type { WorkspaceManager } from '../../kernel/workspace';
import type { BotMessage, ChannelType } from '../../shared/messaging/bot-message.types';
import type { IChannel } from '../../shared/messaging/channel-adapter.types';
import type { StreamEvent } from '../../shared/messaging/stream-event.types';

// ── BotMessage Factory ─────────────────────────────────────

let msgCounter = 0;

export function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  msgCounter++;
  return {
    id: `msg_${msgCounter}_${Date.now()}`,
    channel: 'web',
    userId: 'user_test',
    userName: 'Test User',
    conversationId: 'conv_test',
    content: 'hello',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// ── Mock AgentBridge ─────────────────────────────────

export function createMockAgentBridge(response = 'Claude response'): AgentBridge {
  return {
    execute: mock(async (params: { streamCallback?: (e: StreamEvent) => Promise<void> }) => {
      if (params.streamCallback) {
        await params.streamCallback({ type: 'text_delta', text: response });
        await params.streamCallback({ type: 'done' });
      }
      return {
        content: response,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        toolsUsed: [],
        finishedNaturally: true,
        handledBy: 'claude' as const,
      };
    }),
  };
}

// ── Mock LightLLMClient ────────────────────────────────────

export function createMockLightLLM(response = 'LLM response'): LightLLMClient {
  return {
    complete: mock(async () => ({
      content: response,
      model: 'mock-model',
      usage: { promptTokens: 5, completionTokens: 3, totalCost: 0.0001 },
    })),
    stream: mock(async function* () {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
    getDefaultModel: () => 'mock-model',
  } as unknown as LightLLMClient;
}

// ── Mock OV + Evolution ────────────────────────────────────

export function createMockOVDeps(): Partial<CentralControllerDeps> {
  return {
    knowledgeRouter: {
      buildContext: mock(async () => ({
        systemPrompt: '--- Agent Identity ---\nTest Agent\n--- Agent Soul ---\nBe helpful',
        fragments: [],
        totalTokens: 20,
        conflictsResolved: [],
        retrievedMemories: [],
      })),
    } as unknown as KnowledgeRouter,
    postResponseAnalyzer: {
      analyzeExchange: mock(async () => null),
    } as unknown as PostResponseAnalyzer,
    ovClient: {
      addMessage: mock(async () => {}),
      commit: mock(async () => ({ memories_extracted: 0 })),
      find: mock(async () => []),
    } as unknown as OpenVikingClient,
    contextManager: {
      checkAndFlush: mock(async () => null),
    } as unknown as ContextManager,
    configLoader: {
      loadAll: mock(async () => ({
        soul: 'Be helpful',
        identity: 'Test Agent',
        user: '',
        agents: '',
      })),
      loadFile: mock(async (name: string) => {
        const files: Record<string, string> = {
          'IDENTITY.md': '# Test Agent\nI am a test agent.',
          'SOUL.md': '# Soul\nBe helpful and kind.',
          'AGENTS.md': '# Agents\nCore protocol.',
        };
        return files[name] ?? '';
      }),
      invalidateCache: mock(() => {}),
    } as unknown as ConfigLoader,
    lessonsUpdater: {
      addLesson: mock(async () => true),
    } as unknown as LessonsLearnedUpdater,
    evolutionScheduler: {
      schedulePostCommit: mock(() => {}),
    } as unknown as EvolutionScheduler,
    entityManager: {} as unknown as EntityManager,
  };
}

// ── Mock WorkspaceManager ──────────────────────────────────

export function createMockWorkspaceManager(): WorkspaceManager {
  return {
    initializeWithMcp: mock(() => ({
      absolutePath: '/tmp/test-workspace',
      claudeDir: '/tmp/test-workspace/.claude',
      skillsDir: '/tmp/test-workspace/.claude/skills',
      memoryDir: '/tmp/test-workspace/memory',
    })),
    getWorkspacePath: () => '/tmp/test-workspace',
  } as unknown as WorkspaceManager;
}

// ── Mock MediaProcessor ────────────────────────────────────

export function createMockMediaProcessor(): MediaProcessor {
  return {
    processAttachments: mock(async (attachments: unknown[]) => {
      return attachments.map((_a: unknown, i: number) => ({
        type: 'image',
        status: 'processed',
        originalName: `file_${i}.png`,
        description: `[图片: file_${i}.png 的描述]`,
        localPath: `/tmp/media/file_${i}.png`,
      }));
    }),
    toMediaRef: mock((attachment: unknown) => {
      const a = attachment as { description?: string; localPath?: string };
      return {
        type: 'image',
        description: a.description || 'media',
        localPath: a.localPath || '/tmp/media/test.png',
      };
    }),
  } as unknown as MediaProcessor;
}

// ── Mock Channel ───────────────────────────────────────────

export function createMockChannel(channelType: ChannelType = 'web'): IChannel {
  return {
    type: channelType,
    sendMessage: mock(async () => {}),
    downloadFile: mock(async () => Buffer.from('file-data')),
    createGroupChat: mock(async () => ({
      chatId: 'group_chat_123',
      success: true,
    })),
  } as unknown as IChannel;
}

// ── Mock StreamAdapter ─────────────────────────────────────

export function createMockStreamAdapter(): ChannelStreamAdapter {
  return {
    onStreamStart: mock(async () => {}),
    sendChunk: mock(async () => {}),
    sendError: mock(async () => {}),
    sendDone: mock(async () => {}),
  } as unknown as ChannelStreamAdapter;
}

// ── SQLite :memory: helpers ────────────────────────────────

export function createMemoryDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

export function createStores(db?: Database) {
  const memDb = db ?? createMemoryDb();
  const sessionStore = new SessionStore(memDb);
  const taskStore = new TaskStore(memDb);
  return { db: memDb, sessionStore, taskStore };
}

// ── Mock WorktreePool ──────────────────────────────────────

export function createMockWorktreePool(): WorktreePool {
  const slots: Record<string, { worktreePath: string; branch: string }> = {};
  return {
    acquire: mock(async (taskId: string, branchName: string) => {
      const slotId = `slot_${taskId}`;
      const slot = {
        id: slotId,
        worktreePath: `/tmp/worktree/${branchName}`,
        branch: branchName,
        taskId,
      };
      slots[slotId] = slot;
      return slot;
    }),
    release: mock(async (slotId: string) => {
      delete slots[slotId];
    }),
  } as unknown as WorktreePool;
}

// ── Full Controller Factory ────────────────────────────────

export interface ControllerTestContext {
  controller: CentralController;
  deps: CentralControllerDeps;
  db: Database;
  sessionStore: SessionStore;
  taskStore: TaskStore;
}

export function createTestController(
  overrides?: Partial<CentralControllerDeps>,
): ControllerTestContext {
  CentralController.resetInstance();

  const { db, sessionStore, taskStore } = createStores();
  const agentBridge = createMockAgentBridge();
  const lightLLM = createMockLightLLM();
  const ovDeps = createMockOVDeps();

  const deps: CentralControllerDeps = {
    agentBridge,
    lightLLM,
    sessionStore,
    taskStore,
    workspaceManager: createMockWorkspaceManager(),
    mediaProcessor: createMockMediaProcessor(),
    worktreePool: createMockWorktreePool(),
    ...ovDeps,
    ...overrides,
  };

  const controller = CentralController.getInstance(deps);
  return { controller, deps, db, sessionStore, taskStore };
}

// ── Cleanup helper ─────────────────────────────────────────

export function cleanupController(ctx: ControllerTestContext): void {
  CentralController.resetInstance();
  try {
    ctx.sessionStore.close();
  } catch {
    // already closed
  }
}

// ── Wait helpers ───────────────────────────────────────────

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}
