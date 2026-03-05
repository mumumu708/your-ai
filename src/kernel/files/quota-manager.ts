import { Logger } from '../../shared/logging/logger';
import type { QuotaConfig, UserTier } from './file-types';
import { QUOTA_BY_TIER } from './file-types';

export interface QuotaUsage {
  usedBytes: number;
  fileCount: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  usage: QuotaUsage;
  limits: QuotaConfig;
}

/**
 * Tracks and enforces file storage quotas per user.
 */
export class QuotaManager {
  private readonly logger = new Logger('QuotaManager');
  private readonly usage = new Map<string, QuotaUsage>();
  private readonly tiers = new Map<string, UserTier>();

  setUserTier(userId: string, tier: UserTier): void {
    this.tiers.set(userId, tier);
  }

  getUserTier(userId: string): UserTier {
    return this.tiers.get(userId) ?? 'free';
  }

  getQuotaConfig(userId: string): QuotaConfig {
    return QUOTA_BY_TIER[this.getUserTier(userId)];
  }

  getUsage(userId: string): QuotaUsage {
    return this.usage.get(userId) ?? { usedBytes: 0, fileCount: 0 };
  }

  /**
   * Check if a file can be stored without exceeding quotas.
   */
  checkQuota(userId: string, fileSize: number): QuotaCheckResult {
    const limits = this.getQuotaConfig(userId);
    const current = this.getUsage(userId);

    // Check single file size limit
    if (fileSize > limits.maxFileSizeBytes) {
      return {
        allowed: false,
        reason: `文件大小 ${this.formatBytes(fileSize)} 超过限制 ${this.formatBytes(limits.maxFileSizeBytes)}`,
        usage: current,
        limits,
      };
    }

    // Check total storage limit
    if (current.usedBytes + fileSize > limits.maxStorageBytes) {
      return {
        allowed: false,
        reason: `存储空间不足：已用 ${this.formatBytes(current.usedBytes)}，限额 ${this.formatBytes(limits.maxStorageBytes)}`,
        usage: current,
        limits,
      };
    }

    // Check file count limit
    if (current.fileCount + 1 > limits.maxFileCount) {
      return {
        allowed: false,
        reason: `文件数量已达上限 ${limits.maxFileCount}`,
        usage: current,
        limits,
      };
    }

    return { allowed: true, usage: current, limits };
  }

  /**
   * Record that a file was stored.
   */
  recordStore(userId: string, fileSize: number): void {
    const current = this.getUsage(userId);
    this.usage.set(userId, {
      usedBytes: current.usedBytes + fileSize,
      fileCount: current.fileCount + 1,
    });
  }

  /**
   * Record that a file was deleted.
   */
  recordDelete(userId: string, fileSize: number): void {
    const current = this.getUsage(userId);
    this.usage.set(userId, {
      usedBytes: Math.max(0, current.usedBytes - fileSize),
      fileCount: Math.max(0, current.fileCount - 1),
    });
  }

  /**
   * Recalculate usage from actual file sizes (for consistency).
   */
  resetUsage(userId: string, usedBytes: number, fileCount: number): void {
    this.usage.set(userId, { usedBytes, fileCount });
  }

  /**
   * Get remaining storage for a user.
   */
  getRemainingBytes(userId: string): number {
    const limits = this.getQuotaConfig(userId);
    const current = this.getUsage(userId);
    return Math.max(0, limits.maxStorageBytes - current.usedBytes);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
}
