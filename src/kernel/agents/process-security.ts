import { Logger } from '../../shared/logging/logger';

export interface ProcessSecurityConfig {
  maxProcesses: number;
  processTimeoutMs: number;
  allowedEnvKeys: string[];
}

interface RegisteredProcess {
  sessionId: string;
  pid: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONFIG: ProcessSecurityConfig = {
  maxProcesses: 10,
  processTimeoutMs: 300_000, // 5 minutes
  allowedEnvKeys: ['PATH', 'HOME', 'LANG', 'TERM', 'NODE_ENV'],
};

const BLOCKED_ENV_PATTERNS = [
  /password/i,
  /secret/i,
  /private_key/i,
  /credential/i,
  /token(?!s_)/i,
];

export class ProcessSecurityManager {
  private readonly logger = new Logger('ProcessSecurityManager');
  private readonly config: ProcessSecurityConfig;
  private readonly processes: Map<string, RegisteredProcess> = new Map();

  constructor(config?: Partial<ProcessSecurityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canSpawn(): boolean {
    return this.processes.size < this.config.maxProcesses;
  }

  buildSecureEnv(apiKey: string, sessionId: string): Record<string, string> {
    const env: Record<string, string> = {};

    // Only include allowed env keys from current environment
    for (const key of this.config.allowedEnvKeys) {
      const val = process.env[key];
      if (val !== undefined) {
        env[key] = val;
      }
    }

    // Filter out any sensitive patterns
    for (const key of Object.keys(env)) {
      for (const pattern of BLOCKED_ENV_PATTERNS) {
        if (pattern.test(key)) {
          delete env[key];
          break;
        }
      }
    }

    // Inject controlled variables
    env.ANTHROPIC_API_KEY = apiKey;
    env.SESSION_ID = sessionId;
    env.NODE_ENV = process.env.NODE_ENV ?? 'production';

    return env;
  }

  registerProcess(sessionId: string, proc: { pid: number; kill: (signal?: string) => void }): void {
    if (!this.canSpawn()) {
      this.logger.warn('进程数已达上限，拒绝注册', {
        sessionId,
        current: this.processes.size,
        max: this.config.maxProcesses,
      });
      throw new Error('进程数已达上限');
    }

    const timer = setTimeout(() => {
      this.logger.warn('进程超时，强制终止', {
        sessionId,
        pid: proc.pid,
        timeoutMs: this.config.processTimeoutMs,
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      this.processes.delete(sessionId);
    }, this.config.processTimeoutMs);

    this.processes.set(sessionId, {
      sessionId,
      pid: proc.pid,
      startedAt: Date.now(),
      timer,
    });

    this.logger.info('进程注册', { sessionId, pid: proc.pid });
  }

  deregisterProcess(sessionId: string): void {
    const entry = this.processes.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.processes.delete(sessionId);
      this.logger.info('进程注销', { sessionId, pid: entry.pid });
    }
  }

  getActiveProcessCount(): number {
    return this.processes.size;
  }

  shutdown(): void {
    for (const [sessionId, entry] of this.processes) {
      clearTimeout(entry.timer);
      this.logger.info('关闭时清理进程', { sessionId, pid: entry.pid });
    }
    this.processes.clear();
  }
}
