import { describe, expect, test } from 'bun:test';
import { QuotaManager } from './quota-manager';

describe('QuotaManager', () => {
  test('should default to free tier', () => {
    const qm = new QuotaManager();
    expect(qm.getUserTier('user_001')).toBe('free');
    const config = qm.getQuotaConfig('user_001');
    expect(config.maxStorageBytes).toBe(1 * 1024 * 1024 * 1024); // 1 GB
    expect(config.maxFileSizeBytes).toBe(20 * 1024 * 1024); // 20 MB
    expect(config.maxFileCount).toBe(1000);
  });

  test('should allow setting user tier', () => {
    const qm = new QuotaManager();
    qm.setUserTier('user_001', 'pro');
    expect(qm.getUserTier('user_001')).toBe('pro');
    expect(qm.getQuotaConfig('user_001').maxStorageBytes).toBe(10 * 1024 * 1024 * 1024);
  });

  test('should allow file within quota', () => {
    const qm = new QuotaManager();
    const result = qm.checkQuota('user_001', 1024); // 1 KB file
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('should reject file exceeding single file size limit', () => {
    const qm = new QuotaManager();
    const bigFile = 25 * 1024 * 1024; // 25 MB (free limit is 20 MB)
    const result = qm.checkQuota('user_001', bigFile);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('文件大小');
  });

  test('should reject when total storage exceeded', () => {
    const qm = new QuotaManager();
    // Simulate nearly full storage
    qm.resetUsage('user_001', 1024 * 1024 * 1024 - 100, 10); // 1GB - 100 bytes
    const result = qm.checkQuota('user_001', 1024); // Try adding 1KB
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('存储空间不足');
  });

  test('should reject when file count exceeded', () => {
    const qm = new QuotaManager();
    qm.resetUsage('user_001', 0, 1000); // At max file count for free tier
    const result = qm.checkQuota('user_001', 100);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('文件数量');
  });

  test('should track storage and deletion', () => {
    const qm = new QuotaManager();
    qm.recordStore('user_001', 5000);
    qm.recordStore('user_001', 3000);
    expect(qm.getUsage('user_001')).toEqual({ usedBytes: 8000, fileCount: 2 });

    qm.recordDelete('user_001', 5000);
    expect(qm.getUsage('user_001')).toEqual({ usedBytes: 3000, fileCount: 1 });
  });

  test('should not go below zero on delete', () => {
    const qm = new QuotaManager();
    qm.recordDelete('user_001', 9999);
    expect(qm.getUsage('user_001')).toEqual({ usedBytes: 0, fileCount: 0 });
  });

  test('should calculate remaining bytes', () => {
    const qm = new QuotaManager();
    qm.recordStore('user_001', 500 * 1024 * 1024); // 500 MB used
    const remaining = qm.getRemainingBytes('user_001');
    expect(remaining).toBe(1024 * 1024 * 1024 - 500 * 1024 * 1024);
  });

  test('should allow larger files for pro tier', () => {
    const qm = new QuotaManager();
    qm.setUserTier('user_001', 'pro');
    const bigFile = 50 * 1024 * 1024; // 50 MB
    const result = qm.checkQuota('user_001', bigFile);
    expect(result.allowed).toBe(true);
  });

  test('enterprise tier should have unlimited file count', () => {
    const qm = new QuotaManager();
    qm.setUserTier('user_001', 'enterprise');
    qm.resetUsage('user_001', 0, 999999);
    const result = qm.checkQuota('user_001', 100);
    expect(result.allowed).toBe(true);
  });
});
