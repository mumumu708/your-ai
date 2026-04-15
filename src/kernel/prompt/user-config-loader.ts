import { join } from 'node:path';
import { Logger } from '../../shared/logging/logger';
import type { AIEOSConfig } from './config-loader';
import type { ConfigLoader } from './config-loader';
import type { OpenVikingClient } from '../memory/openviking/openviking-client';

const VIKING_USER_CONFIG_URI = 'viking://user';

/**
 * Per-user config loader with three-level fallback:
 *   1. user-space/{userId}/memory/{filename}  (local)
 *   2. viking://user/{userId}/config/{filename}  (VikingFS)
 *   3. Global config via ConfigLoader  (shared default)
 */
export class UserConfigLoader {
  private readonly logger = new Logger('UserConfigLoader');
  private cache: AIEOSConfig | null = null;
  private lastLoad = 0;
  private readonly cacheTTL = 60_000; // 1 minute
  private readonly localDir: string;
  private dirEnsured = false;

  constructor(
    private readonly userId: string,
    private readonly ov: OpenVikingClient,
    private readonly globalConfigLoader: ConfigLoader,
    workspacePath: string,
  ) {
    this.localDir = join(workspacePath, 'memory');
  }

  /** Load all 4 AIEOS config files with per-user priority */
  async loadAll(forceRefresh = false): Promise<AIEOSConfig> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.lastLoad < this.cacheTTL) {
      return this.cache;
    }

    // Ensure the user's config directory exists to avoid noisy
    // server-side FileNotFoundError on ls/read calls
    await this.ensureRemoteDir();

    // Pre-check which user config files exist on VikingFS
    let remoteFiles: Set<string>;
    try {
      const entries = await this.ov.ls(`${VIKING_USER_CONFIG_URI}/${this.userId}/config`);
      remoteFiles = new Set(entries.map((e) => e.name));
    } catch {
      remoteFiles = new Set();
    }

    const [soul, identity, user, agents] = await Promise.all([
      this.loadFile('SOUL.md', remoteFiles),
      this.loadFile('IDENTITY.md', remoteFiles),
      this.loadFile('USER.md', remoteFiles),
      this.loadFile('AGENTS.md', remoteFiles),
    ]);

    this.cache = { soul, identity, user, agents };
    this.lastLoad = now;
    this.logger.debug('用户配置加载完成', { userId: this.userId });
    return this.cache;
  }

  /** Write config to local user-space + VikingFS */
  async writeConfig(filename: string, content: string): Promise<void> {
    const localPath = `${this.localDir}/${filename}`;

    // Ensure directory exists
    const { mkdirSync } = require('node:fs');
    try {
      mkdirSync(this.localDir, { recursive: true });
    } catch {
      // directory may already exist
    }

    await Bun.write(localPath, content);

    // Sync to VikingFS (ensure dir exists first)
    await this.ensureRemoteDir();
    try {
      await this.ov.write(`${VIKING_USER_CONFIG_URI}/${this.userId}/config/${filename}`, content);
    } catch (err) {
      this.logger.warn('VikingFS 同步用户配置失败', {
        userId: this.userId,
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.invalidateCache();
  }

  /** Check if user has their own copy of a config file */
  async hasUserConfig(filename: string): Promise<boolean> {
    const localPath = `${this.localDir}/${filename}`;
    try {
      const file = Bun.file(localPath);
      if (await file.exists()) return true;
    } catch {
      // fall through
    }

    // Check VikingFS via ls (ensureRemoteDir avoids noisy server errors)
    await this.ensureRemoteDir();
    try {
      const entries = await this.ov.ls(`${VIKING_USER_CONFIG_URI}/${this.userId}/config`);
      return entries.some((e) => e.name === filename);
    } catch {
      return false;
    }
  }

  /** Invalidate the config cache */
  invalidateCache(): void {
    this.cache = null;
  }

  getLocalDir(): string {
    return this.localDir;
  }

  private static readonly CONFIG_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md'];

  /** Ensure the user's remote config directory exists and sync local files (once per instance) */
  private async ensureRemoteDir(): Promise<void> {
    if (this.dirEnsured) return;
    this.dirEnsured = true;

    const remoteDir = `${VIKING_USER_CONFIG_URI}/${this.userId}/config`;
    try {
      await this.ov.mkdir(remoteDir);
    } catch {
      // mkdir is idempotent; other errors (network etc.) are non-fatal
    }

    // Sync local config files that are missing on VikingFS
    let remoteFiles: Set<string>;
    try {
      const entries = await this.ov.ls(remoteDir);
      remoteFiles = new Set(entries.map((e) => e.name));
    } catch {
      remoteFiles = new Set();
    }

    for (const filename of UserConfigLoader.CONFIG_FILES) {
      if (remoteFiles.has(filename)) continue;
      try {
        const file = Bun.file(`${this.localDir}/${filename}`);
        if (await file.exists()) {
          const content = await file.text();
          await this.ov.write(`${remoteDir}/${filename}`, content);
          this.logger.debug('本地配置已同步到 VikingFS', { userId: this.userId, filename });
        }
      } catch {
        // best-effort sync
      }
    }
  }

  /** Load a single file with three-level fallback */
  private async loadFile(filename: string, remoteFiles?: Set<string>): Promise<string> {
    const localPath = `${this.localDir}/${filename}`;

    // Level 1: user-space local file
    try {
      const file = Bun.file(localPath);
      if (await file.exists()) {
        return await file.text();
      }
    } catch {
      // fall through
    }

    // Level 2: VikingFS user config (skip if we know the file doesn't exist remotely)
    if (!remoteFiles || remoteFiles.has(filename)) {
      const content = await this.ov.tryRead(
        `${VIKING_USER_CONFIG_URI}/${this.userId}/config/${filename}`,
      );
      if (content && !content.startsWith('<!--')) {
        return content;
      }
    }

    // Level 3: global config fallback
    return this.globalConfigLoader.loadFile(filename);
  }
}
