import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { BunGitOperations } from './git-operations';

describe('BunGitOperations', () => {
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

  test('addWorktree 成功时不抛异常', async () => {
    const ops = new BunGitOperations();

    const mockProc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    };
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockProc as never);

    await ops.addWorktree('/tmp/wt', 'agent/feat/test', 'main');

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]![0]).toEqual([
      'git',
      'worktree',
      'add',
      '/tmp/wt',
      '-b',
      'agent/feat/test',
      'main',
    ]);

    spawnSpy.mockRestore();
  });

  test('addWorktree 失败时抛出包含 stderr 的错误', async () => {
    const ops = new BunGitOperations();

    const stderrStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('fatal: branch exists'));
        controller.close();
      },
    });
    const mockProc = {
      exited: Promise.resolve(128),
      stdout: new ReadableStream(),
      stderr: stderrStream,
    };
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockProc as never);

    await expect(ops.addWorktree('/tmp/wt', 'branch', 'main')).rejects.toThrow(
      'git worktree add 失败',
    );

    spawnSpy.mockRestore();
  });

  test('removeWorktree 成功时不抛异常', async () => {
    const ops = new BunGitOperations();

    const mockProc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    };
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockProc as never);

    await ops.removeWorktree('/tmp/wt');

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]![0]).toEqual([
      'git',
      'worktree',
      'remove',
      '/tmp/wt',
      '--force',
    ]);

    spawnSpy.mockRestore();
  });

  test('removeWorktree 失败时抛出错误', async () => {
    const ops = new BunGitOperations();

    const stderrStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not a worktree'));
        controller.close();
      },
    });
    const mockProc = {
      exited: Promise.resolve(1),
      stdout: new ReadableStream(),
      stderr: stderrStream,
    };
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(mockProc as never);

    await expect(ops.removeWorktree('/tmp/wt')).rejects.toThrow('git worktree remove 失败');

    spawnSpy.mockRestore();
  });
});
