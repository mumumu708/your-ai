import { Logger } from '../../shared/logging/logger';

/**
 * Abstraction over git worktree operations, injectable for testing.
 */
export interface GitOperations {
  addWorktree(worktreePath: string, branchName: string, baseBranch: string): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
}

export class BunGitOperations implements GitOperations {
  private readonly logger = new Logger('BunGitOperations');

  async addWorktree(worktreePath: string, branchName: string, baseBranch: string): Promise<void> {
    const proc = Bun.spawn(['git', 'worktree', 'add', worktreePath, '-b', branchName, baseBranch], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git worktree add 失败 (exit ${exitCode}): ${stderr.trim()}`);
    }
    this.logger.info('Worktree 已创建', { worktreePath, branchName });
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const proc = Bun.spawn(['git', 'worktree', 'remove', worktreePath, '--force'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      this.logger.warn('Worktree 移除失败', { worktreePath, error: stderr.trim() });
      throw new Error(`git worktree remove 失败 (exit ${exitCode}): ${stderr.trim()}`);
    }
    this.logger.info('Worktree 已移除', { worktreePath });
  }
}
