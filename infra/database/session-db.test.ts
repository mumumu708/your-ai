/**
 * session-db 单元测试
 *
 * 覆盖场景：SC-108
 * 补充原因：数据库基础设施层完全无测试
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { closeSessionDatabase, getSessionDatabase } from './session-db';

const TEST_DB_PATH = '/tmp/test-session-db-unit.db';

describe('session-db', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    // Clean up any leftover test DB
    closeSessionDatabase();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(`${TEST_DB_PATH}-wal`)) rmSync(`${TEST_DB_PATH}-wal`);
    if (existsSync(`${TEST_DB_PATH}-shm`)) rmSync(`${TEST_DB_PATH}-shm`);
  });

  afterEach(() => {
    closeSessionDatabase();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(`${TEST_DB_PATH}-wal`)) rmSync(`${TEST_DB_PATH}-wal`);
    if (existsSync(`${TEST_DB_PATH}-shm`)) rmSync(`${TEST_DB_PATH}-shm`);
    logSpy.mockRestore();
  });

  describe('getSessionDatabase', () => {
    test('应该创建并返回 Database 实例', () => {
      const db = getSessionDatabase(TEST_DB_PATH);
      expect(db).toBeDefined();
      expect(typeof db.exec).toBe('function');
    });

    test('应该返回单例（多次调用同一实例）', () => {
      const db1 = getSessionDatabase(TEST_DB_PATH);
      const db2 = getSessionDatabase(TEST_DB_PATH);
      expect(db1).toBe(db2);
    });

    test('不同路径调用应该返回同一实例并发出警告', () => {
      const warnSpy = spyOn(console, 'log'); // logger.warn goes through console.log
      const db1 = getSessionDatabase(TEST_DB_PATH);
      const db2 = getSessionDatabase('/tmp/other-db.db');
      expect(db1).toBe(db2); // 仍然是同一个单例
      warnSpy.mockRestore();
    });

    test('应该启用 WAL 模式', () => {
      const db = getSessionDatabase(TEST_DB_PATH);
      const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(result.journal_mode).toBe('wal');
    });

    test('应该设置 synchronous = NORMAL', () => {
      const db = getSessionDatabase(TEST_DB_PATH);
      const result = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
      // NORMAL = 1
      expect(result.synchronous).toBe(1);
    });

    test('应该设置 cache_size', () => {
      const db = getSessionDatabase(TEST_DB_PATH);
      const result = db.prepare('PRAGMA cache_size').get() as { cache_size: number };
      expect(result.cache_size).toBe(-64000);
    });

    test('应该创建数据目录（如果不存在）', () => {
      const nestedPath = '/tmp/test-session-db-nested/sub/session.db';
      const db = getSessionDatabase(nestedPath);
      expect(db).toBeDefined();

      closeSessionDatabase();
      // Clean up
      rmSync('/tmp/test-session-db-nested', { recursive: true, force: true });
    });
  });

  describe('closeSessionDatabase', () => {
    test('关闭后 getSessionDatabase 应该返回新实例', () => {
      const db1 = getSessionDatabase(TEST_DB_PATH);
      closeSessionDatabase();
      const db2 = getSessionDatabase(TEST_DB_PATH);

      // 新实例（不是同一个引用）
      expect(db1).not.toBe(db2);
    });

    test('多次关闭应该幂等', () => {
      getSessionDatabase(TEST_DB_PATH);
      closeSessionDatabase();
      closeSessionDatabase(); // 不应抛出
    });

    test('未初始化时关闭应该静默', () => {
      closeSessionDatabase(); // 不应抛出
    });
  });
});
