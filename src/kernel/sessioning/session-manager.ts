import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import type { Session } from '../../shared/tasking/task.types';
import { generateSessionId } from '../../shared/utils/crypto';
import type { ContextSummary, SessionSummary } from '../memory/memory-types';
import { SessionMemoryExtractor } from '../memory/session-memory-extractor';
import type { SessionStore } from '../memory/session-store';
import { WorkingMemory } from '../memory/working-memory';

export type SessionCloseCallback = (
  summary: SessionSummary,
  sessionId: string,
  session: Session,
) => void | Promise<void>;

export class SessionManager {
  private readonly logger = new Logger('SessionManager');
  private readonly sessions: Map<string, Session> = new Map();
  private readonly sessionTimeout: number;
  private readonly memoryExtractor = new SessionMemoryExtractor();
  private readonly sessionStore?: SessionStore;
  private onSessionClose: SessionCloseCallback | null = null;

  constructor(options: { sessionTimeoutMs?: number; sessionStore?: SessionStore } = {}) {
    this.sessionTimeout = options.sessionTimeoutMs ?? 1800000; // 30 minutes
    this.sessionStore = options.sessionStore;
  }

  setOnSessionClose(callback: SessionCloseCallback): void {
    this.onSessionClose = callback;
  }

  async resolveSession(userId: string, channel: string, conversationId: string): Promise<Session> {
    const key = `${userId}:${channel}:${conversationId}`;
    const existing = this.sessions.get(key);

    if (existing && existing.status === 'active' && !this.isExpired(existing)) {
      existing.lastActiveAt = Date.now();
      this.logger.debug('会话复用', { sessionId: existing.id, key });
      return existing;
    }

    // Close the expired session and extract memory
    if (existing && existing.status === 'active' && this.isExpired(existing)) {
      await this.closeSession(key);
    }

    const session: Session = {
      id: generateSessionId(),
      userId,
      channel,
      conversationId,
      status: 'active',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      agentConfig: { maxContextTokens: 100000 },
      messages: [],
      workingMemory: new WorkingMemory({ maxTokens: 100000 }),
    };
    this.sessions.set(key, session);
    this.sessionStore?.createSession({
      id: session.id,
      userId,
      channel,
      conversationId,
      startedAt: session.createdAt,
    });
    this.logger.info('会话创建', { sessionId: session.id, key });
    return session;
  }

  addMessage(sessionKey: string, message: ConversationMessage): void {
    const session = this.findSessionByKey(sessionKey);
    if (session) {
      session.messages.push(message);
      session.lastActiveAt = Date.now();
      // Sync to WorkingMemory for automatic compression
      session.workingMemory?.addMessage(message);
      // Persist to SQLite (batched async write)
      // Serialize mediaRefs (without base64Data) for persistence
      let mediaRefsJson: string | undefined;
      if (message.mediaRefs?.length) {
        mediaRefsJson = JSON.stringify(message.mediaRefs.map(({ base64Data: _, ...rest }) => rest));
      }
      this.sessionStore?.appendMessage({
        sessionId: session.id,
        userId: session.userId,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        tokenEstimate: Math.ceil(message.content.length / 4),
        mediaRefsJson,
      });
    }
  }

  getRecentMessages(sessionKey: string, count: number): ConversationMessage[] {
    const session = this.findSessionByKey(sessionKey);
    if (!session) return [];
    return session.messages.slice(-count);
  }

  /**
   * Get context-aware messages with summaries from WorkingMemory.
   * Returns compressed summaries of older messages + recent messages.
   */
  getContextMessages(sessionKey: string): {
    summaries: ContextSummary[];
    messages: ConversationMessage[];
  } {
    const session = this.findSessionByKey(sessionKey);
    if (!session) return { summaries: [], messages: [] };

    if (session.workingMemory) {
      return session.workingMemory.buildContext();
    }

    // Fallback: no summaries, return all messages
    return { summaries: [], messages: [...session.messages] };
  }

  markToolUsed(sessionKey: string): void {
    const session = this.findSessionByKey(sessionKey);
    if (session) {
      session.hasRecentToolUse = true;
    }
  }

  /** DD-021: Bind a Feishu thread ID to a session for grouped replies */
  updateThreadBinding(sessionKey: string, threadId: string): void {
    const session = this.findSessionByKey(sessionKey);
    if (session) {
      session.threadId = threadId;
      this.logger.info('ThreadId 已绑定', { sessionId: session.id, threadId });
    }
  }

  getSessionByKey(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  /**
   * Destroy a session without triggering onSessionClose callback.
   * Used by benchmark QA phase to avoid polluting the memory store.
   */
  destroySession(key: string): void {
    const session = this.findSessionByKey(key);
    if (session) {
      session.status = 'closed';
      this.sessions.delete(key);
      this.logger.debug('会话销毁（无回调）', { sessionId: session.id, key });
    }
  }

  private findSessionByKey(key: string): Session | undefined {
    // Try direct key lookup first
    const direct = this.sessions.get(key);
    if (direct) return direct;

    // Try finding by session ID
    for (const session of this.sessions.values()) {
      if (session.id === key) return session;
    }

    return undefined;
  }

  private isExpired(session: Session): boolean {
    return Date.now() - session.lastActiveAt > this.sessionTimeout;
  }

  /**
   * Close a session: extract memory summary and trigger callback.
   * The callback now receives the sessionId for OpenViking commit.
   */
  async closeSession(
    sessionKey: string,
    reason: 'idle_timeout' | 'user_end' | 'admin_close' | 'process_restart' = 'idle_timeout',
  ): Promise<SessionSummary | null> {
    const session = this.findSessionByKey(sessionKey);
    if (!session) return null;

    session.status = 'closed';

    if (session.messages.length === 0) return null;

    const summary = await this.memoryExtractor.extract(
      session.id,
      session.userId,
      session.messages,
    );

    this.logger.info('会话关闭', {
      sessionId: session.id,
      messageCount: session.messages.length,
      keywords: summary.keywords.length,
      reason,
    });

    // Persist session close to SQLite
    this.sessionStore?.closeSession(session.id, reason, summary.summary);

    if (this.onSessionClose) {
      await this.onSessionClose(summary, session.id, session);
    }

    return summary;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }
}
