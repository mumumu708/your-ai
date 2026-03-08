import type { ConversationMessage } from '../../shared/agents/agent-instance.types';
import { Logger } from '../../shared/logging/logger';
import type { Session } from '../../shared/tasking/task.types';
import { generateSessionId } from '../../shared/utils/crypto';
import type { ContextSummary, SessionSummary } from '../memory/memory-types';
import { SessionMemoryExtractor } from '../memory/session-memory-extractor';
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
  private onSessionClose: SessionCloseCallback | null = null;

  constructor(options: { sessionTimeoutMs?: number } = {}) {
    this.sessionTimeout = options.sessionTimeoutMs ?? 1800000; // 30 minutes
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

  getSessionByKey(key: string): Session | undefined {
    return this.sessions.get(key);
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
  async closeSession(sessionKey: string): Promise<SessionSummary | null> {
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
    });

    if (this.onSessionClose) {
      await this.onSessionClose(summary, session.id, session);
    }

    return summary;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }
}
