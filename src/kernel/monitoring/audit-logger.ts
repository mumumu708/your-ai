import { Logger } from '../../shared/logging/logger';

// --- Types ---

export type AuditEventType =
  | 'tool_call'
  | 'config_generated'
  | 'permission_denied'
  | 'approval_required';

export interface AuditLogEntry {
  timestamp: string;
  eventType: AuditEventType;
  sessionId: string;
  userId: string;
  tenantId: string;
  serverId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: 'success' | 'error' | 'denied';
  details?: string;
}

export interface AuditStore {
  append(entry: AuditLogEntry): Promise<void>;
}

// --- In-Memory Store (default) ---

export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditLogEntry[] = [];

  async append(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  getEntries(): readonly AuditLogEntry[] {
    return this.entries;
  }

  query(
    filter: Partial<Pick<AuditLogEntry, 'userId' | 'sessionId' | 'eventType'>>,
  ): AuditLogEntry[] {
    return this.entries.filter((e) => {
      if (filter.userId && e.userId !== filter.userId) return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      if (filter.eventType && e.eventType !== filter.eventType) return false;
      return true;
    });
  }
}

// --- Audit Logger ---

const SENSITIVE_KEYS = ['password', 'token', 'secret', 'api_key', 'credential', 'authorization'];

export class AuditLogger {
  private readonly logger = new Logger('AuditLogger');
  private readonly store: AuditStore;

  constructor(store?: AuditStore) {
    this.store = store ?? new InMemoryAuditStore();
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const sanitized: AuditLogEntry = {
      ...entry,
      input: entry.input ? this.redactSensitiveFields(entry.input) : undefined,
    };

    await this.store.append(sanitized);
    this.logger.info('审计日志', {
      eventType: sanitized.eventType,
      userId: sanitized.userId,
      serverId: sanitized.serverId,
      toolName: sanitized.toolName,
      result: sanitized.result,
    });
  }

  redactSensitiveFields(input: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (SENSITIVE_KEYS.some((sk) => key.toLowerCase().includes(sk))) {
        redacted[key] = '[REDACTED]';
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        redacted[key] = this.redactSensitiveFields(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }
}
