import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitOperations } from './git-operations';
import { WorktreePool } from './worktree-pool';

function createMockGitOps(): GitOperations & {
  addCalls: Array<{ worktreePath: string; branchName: string; baseBranch: string }>;
  removeCalls: string[];
} {
  const mock = {
    addCalls: [] as Array<{ worktreePath: string; branchName: string; baseBranch: string }>,
    removeCalls: [] as string[],
    async addWorktree(worktreePath: string, branchName: string, baseBranch: string) {
      mock.addCalls.push({ worktreePath, branchName, baseBranch });
    },
    async removeWorktree(worktreePath: string) {
      mock.removeCalls.push(worktreePath);
    },
  };
  return mock;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WorktreePool', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('应立即获取 slot 并执行任务', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt' });

    const result = await pool.run('task1', 'agent/feat/test', async (slot) => {
      expect(slot.branch).toBe('agent/feat/test');
      expect(slot.taskId).toBe('task1');
      expect(slot.worktreePath).toContain('/tmp/wt/harness-');
      return 42;
    });

    expect(result).toBe(42);
    expect(gitOps.addCalls.length).toBe(1);
    expect(gitOps.removeCalls.length).toBe(1);
    expect(pool.getActiveCount()).toBe(0);
  });

  test('并发任务不超过 maxConcurrent', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt', maxConcurrent: 2 });

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const task = async () => {
      return pool.run('task', 'agent/feat/t', async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await delay(30);
        currentConcurrent--;
      });
    };

    await Promise.all([task(), task(), task()]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(pool.getActiveCount()).toBe(0);
  });

  test('队列排队应遵循 FIFO 顺序', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt', maxConcurrent: 1 });
    const order: number[] = [];

    const p1 = pool.run('t1', 'agent/feat/a', async () => {
      await delay(30);
      order.push(1);
    });

    const p2 = pool.run('t2', 'agent/feat/b', async () => {
      order.push(2);
    });

    const p3 = pool.run('t3', 'agent/feat/c', async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('超时应拒绝等待中的任务', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({
      gitOps,
      basePath: '/tmp/wt',
      maxConcurrent: 1,
      timeoutMs: 50,
    });

    const p1 = pool.run('t1', 'agent/feat/a', async () => {
      await delay(200);
    });

    const p2 = pool.run('t2', 'agent/feat/b', async () => 'should-not-run');

    const results = await Promise.allSettled([p1, p2]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
  });

  test('任务异常时应正确释放 slot', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt', maxConcurrent: 1 });

    try {
      await pool.run('t1', 'agent/feat/a', async () => {
        throw new Error('task error');
      });
    } catch {
      // expected
    }

    expect(pool.getActiveCount()).toBe(0);
    expect(gitOps.removeCalls.length).toBe(1);

    // Should be able to acquire again
    const result = await pool.run('t2', 'agent/feat/b', async () => 'ok');
    expect(result).toBe('ok');
  });

  test('getActiveCount 和 getWaitingCount 应正确反映状态', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt', maxConcurrent: 1 });

    expect(pool.getActiveCount()).toBe(0);
    expect(pool.getWaitingCount()).toBe(0);

    const p1 = pool.run('t1', 'agent/feat/a', async () => {
      await delay(50);
    });

    await delay(1);
    expect(pool.getActiveCount()).toBe(1);

    const p2Promise = pool.run('t2', 'agent/feat/b', async () => {});
    await delay(1);
    expect(pool.getWaitingCount()).toBe(1);

    await Promise.all([p1, p2Promise]);
    expect(pool.getActiveCount()).toBe(0);
    expect(pool.getWaitingCount()).toBe(0);
  });

  test('removeWorktree 失败应容错', async () => {
    const gitOps = createMockGitOps();
    gitOps.removeWorktree = async () => {
      throw new Error('remove failed');
    };
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt' });

    // Should not throw even though removeWorktree fails
    const result = await pool.run('t1', 'agent/feat/a', async () => 'ok');
    expect(result).toBe('ok');
    expect(pool.getActiveCount()).toBe(0);
  });

  test('释放不存在的 slot 应静默处理', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt' });

    // Should not throw
    await pool.release('nonexistent-slot');
    expect(gitOps.removeCalls.length).toBe(0);
  });

  test('cleanupStale 在目录不存在时应静默返回', () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/nonexistent/path' });

    // Should not throw
    pool.cleanupStale();
    expect(gitOps.removeCalls.length).toBe(0);
  });

  test('acquire 应传递 baseBranch 给 gitOps', async () => {
    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt', baseBranch: 'develop' });

    await pool.run('t1', 'agent/feat/test', async () => {});

    expect(gitOps.addCalls[0]!.baseBranch).toBe('develop');
  });

  test('addWorktree 失败时应回滚 slot 并唤醒等待者', async () => {
    let callCount = 0;
    const gitOps = createMockGitOps();
    gitOps.addWorktree = async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('git add failed');
      }
    };
    const pool = new WorktreePool({ gitOps, basePath: '/tmp/wt', maxConcurrent: 1 });

    // First task succeeds and blocks the slot
    const result = await pool.run('t1', 'agent/feat/a', async () => 'ok');
    expect(result).toBe('ok');

    // Second task's addWorktree will fail — slot should be rolled back
    await expect(pool.run('t2', 'agent/feat/b', async () => 'fail')).rejects.toThrow(
      'git add failed',
    );
    expect(pool.getActiveCount()).toBe(0);

    // Third task should still succeed after rollback
    const result3 = await pool.run('t3', 'agent/feat/c', async () => 'recovered');
    expect(result3).toBe('recovered');
  });

  test('cleanupStale 应清理目录中的 harness-* 子目录', () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'wt-test-'));
    mkdirSync(join(tmpBase, 'harness-old-1'));
    mkdirSync(join(tmpBase, 'harness-old-2'));
    mkdirSync(join(tmpBase, 'other-dir'));

    const gitOps = createMockGitOps();
    const pool = new WorktreePool({ gitOps, basePath: tmpBase });

    pool.cleanupStale();

    // Should only clean harness-* directories
    expect(gitOps.removeCalls.length).toBe(2);
    expect(gitOps.removeCalls).toContain(join(tmpBase, 'harness-old-1'));
    expect(gitOps.removeCalls).toContain(join(tmpBase, 'harness-old-2'));

    rmSync(tmpBase, { recursive: true });
  });

  test('cleanupStale 应容忍 removeWorktree 失败', () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'wt-test-'));
    mkdirSync(join(tmpBase, 'harness-stale'));

    const gitOps = createMockGitOps();
    gitOps.removeWorktree = async () => {
      throw new Error('cleanup failed');
    };
    const pool = new WorktreePool({ gitOps, basePath: tmpBase });

    // Should not throw
    pool.cleanupStale();

    rmSync(tmpBase, { recursive: true });
  });
});
