import { Logger } from '../../shared/logging/logger';
import type { OpenVikingClient } from './openviking/openviking-client';

export interface AIEOSConfig {
  soul: string;
  identity: string;
  user: string;
  agents: string;
}

const CONFIG_DIR = './config';
const VIKING_CONFIG_URI = 'viking://agent/config';

/**
 * Loads AIEOS protocol files with local-first strategy and VikingFS fallback.
 * Caches loaded config for 1 minute to reduce I/O.
 */
export class ConfigLoader {
  private readonly logger = new Logger('ConfigLoader');
  private cache: AIEOSConfig | null = null;
  private lastLoad = 0;
  private readonly cacheTTL = 60_000; // 1 minute

  constructor(private readonly ov: OpenVikingClient) {}

  /** Load all 4 AIEOS config files */
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
    this.logger.debug('AIEOS 配置加载完成');
    return this.cache;
  }

  /** Get the Lessons Learned section from SOUL.md */
  async getLessonsLearned(): Promise<string> {
    const config = await this.loadAll();
    const marker = '## Lessons Learned';
    const idx = config.soul.indexOf(marker);
    if (idx < 0) return '';
    return config.soul.slice(idx + marker.length).trim();
  }

  /** Update USER.md (write to local + sync to VikingFS) */
  async updateUserProfile(newContent: string): Promise<void> {
    await Bun.write(`${CONFIG_DIR}/USER.md`, newContent);
    try {
      await this.ov.write(`${VIKING_CONFIG_URI}/USER.md`, newContent);
    } catch (err) {
      this.logger.warn('VikingFS 同步 USER.md 失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.invalidateCache();
  }

  /** Invalidate the config cache — next loadAll() will re-read from disk/VikingFS */
  invalidateCache(): void {
    this.cache = null;
  }

  /** Load a single file: local-first, VikingFS fallback */
  async loadFile(filename: string): Promise<string> {
    const localPath = `${CONFIG_DIR}/${filename}`;

    // Try local file first
    try {
      const file = Bun.file(localPath);
      if (await file.exists()) {
        return await file.text();
      }
    } catch {
      // Fall through to VikingFS
    }

    // Fallback to VikingFS
    try {
      return await this.ov.read(`${VIKING_CONFIG_URI}/${filename}`);
    } catch {
      this.logger.warn(`${filename} not found locally or in VikingFS`);
      return `<!-- ${filename} not found -->`;
    }
  }
}
