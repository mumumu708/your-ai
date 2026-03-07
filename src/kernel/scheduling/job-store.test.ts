import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ScheduledJob } from './scheduler';
import { JobStore } from './job-store';

const TEST_DIR = join(import.meta.dir, '__test_store__');
const TEST_FILE = join(TEST_DIR, 'jobs.json');

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job_test_1',
    cronExpression: '0 9 * * *',
    taskTemplate: { action: 'remind' },
    userId: 'user_001',
    description: 'Test job',
    channel: 'api',
    status: 'active',
    nextRunAt: Date.now() + 60_000,
    createdAt: Date.now(),
    executionCount: 0,
    lastResult: null,
    ...overrides,
  };
}

describe('JobStore', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test('load 应该在文件不存在时返回空数组', () => {
    const store = new JobStore(TEST_FILE);
    expect(store.load()).toEqual([]);
  });

  test('save/load 往返应该保持数据一致', () => {
    const store = new JobStore(TEST_FILE);
    const jobs = [makeJob({ id: 'job_a' }), makeJob({ id: 'job_b', status: 'paused' })];

    store.save(jobs);
    const loaded = store.load();

    expect(loaded.length).toBe(2);
    expect(loaded[0].id).toBe('job_a');
    expect(loaded[1].id).toBe('job_b');
    expect(loaded[1].status).toBe('paused');
  });

  test('save 应该过滤掉 cancelled 的 job', () => {
    const store = new JobStore(TEST_FILE);
    const jobs = [
      makeJob({ id: 'job_active', status: 'active' }),
      makeJob({ id: 'job_cancelled', status: 'cancelled' }),
      makeJob({ id: 'job_paused', status: 'paused' }),
    ];

    store.save(jobs);
    const loaded = store.load();

    expect(loaded.length).toBe(2);
    expect(loaded.map((j) => j.id)).toEqual(['job_active', 'job_paused']);
  });

  test('save 应该自动创建目录', () => {
    const nestedPath = join(TEST_DIR, 'nested', 'dir', 'jobs.json');
    const store = new JobStore(nestedPath);

    store.save([makeJob()]);

    expect(existsSync(nestedPath)).toBe(true);
  });

  test('load 应该在 JSON 解析失败时返回空数组', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_FILE, 'invalid json!!!', 'utf-8');

    const store = new JobStore(TEST_FILE);
    const loaded = store.load();

    expect(loaded).toEqual([]);
  });
});
