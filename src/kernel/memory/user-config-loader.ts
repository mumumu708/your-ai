import { Logger } from '../../shared/logging/logger';
import type { AIEOSConfig } from './config-loader';
import type { ConfigLoader } from './config-loader';
import type { OpenVikingClient } from './openviking/openviking-client';

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

  constructor(
    private readonly userId: string,
    private readonly ov: OpenVikingClient,
    private readonly globalConfigLoader: ConfigLoader,
    workspacePath: string,
  ) {
    this.localDir = `user-space/${userId}/memory`;
  }

  /** Load all 4 AIEOS config files with per-user priority */
  async loadAll(forceRefresh = false): Promise<AIEOSConfig> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.lastLoad < this.cacheTTL) {
      return this.cache;
    }

    const [soul, identity, user, agents] = await Promise.all([
      this.loadFile('SOUL.md'),
      this.loadFile('IDENTITY.md'),
      this.loadFile('USER.md'),
      this.loadFile('AGENTS.md'),
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

    // Sync to VikingFS
    try {
      await this.ov.write(
        `${VIKING_USER_CONFIG_URI}/${this.userId}/config/${filename}`,
        content,
      );
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

    // Check VikingFS
    try {
      const content = await this.ov.read(
        `${VIKING_USER_CONFIG_URI}/${this.userId}/config/${filename}`,
      );
      return !!content && !content.startsWith('<!--');
    } catch {
      return false;
    }
  }

  /** Invalidate the config cache */
  invalidateCache(): void {
    this.cache = null;
  }

  /** Load a single file with three-level fallback */
  private async loadFile(filename: string): Promise<string> {
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

    // Level 2: VikingFS user config
    try {
      const content = await this.ov.read(
        `${VIKING_USER_CONFIG_URI}/${this.userId}/config/${filename}`,
      );
      if (content && !content.startsWith('<!--')) {
        return content;
      }
    } catch {
      // fall through
    }

    // Level 3: global config fallback
    return this.globalConfigLoader.loadFile(filename);
  }
}
