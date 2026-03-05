import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { Logger } from '../../shared/logging/logger';
import type { FileCategory, FileEntry } from './file-types';

/**
 * Abstracted file system operations for testability.
 */
export interface FileManagerOps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string | Buffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  readdir(
    path: string,
  ): Promise<Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>>;
  stat(path: string): Promise<{ size: number; isDirectory: boolean; modifiedAt: number }>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/**
 * Secure file manager with path traversal prevention.
 * All operations are sandboxed within the user's workspace directory.
 */
export class FileManager {
  private readonly logger = new Logger('FileManager');
  private readonly userId: string;
  private readonly basePath: string;
  private readonly fs: FileManagerOps;

  constructor(userId: string, workspacePath: string, fileOps: FileManagerOps) {
    this.userId = userId;
    this.basePath = workspacePath;
    this.fs = fileOps;
  }

  async readFile(path: string): Promise<string> {
    const resolved = this.resolveSafe(path);
    return this.fs.readFile(resolved);
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const resolved = this.resolveSafe(path);
    // Ensure parent directory exists
    const parentDir = resolved.substring(0, resolved.lastIndexOf('/'));
    if (parentDir && !(await this.fs.exists(parentDir))) {
      await this.fs.mkdir(parentDir);
    }
    await this.fs.writeFile(resolved, content);
    this.logger.info('文件写入', { userId: this.userId, path });
  }

  async deleteFile(path: string): Promise<void> {
    const resolved = this.resolveSafe(path);
    await this.fs.unlink(resolved);
    this.logger.info('文件删除', { userId: this.userId, path });
  }

  async listDirectory(path: string): Promise<FileEntry[]> {
    const resolved = this.resolveSafe(path);
    const entries = await this.fs.readdir(resolved);
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory ? ('directory' as const) : ('file' as const),
      size: e.size,
      modifiedAt: e.modifiedAt,
    }));
  }

  async moveFile(from: string, to: string): Promise<void> {
    const resolvedFrom = this.resolveSafe(from);
    const resolvedTo = this.resolveSafe(to);
    await this.fs.rename(resolvedFrom, resolvedTo);
    this.logger.info('文件移动', { userId: this.userId, from, to });
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolveSafe(path);
    return this.fs.exists(resolved);
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean }> {
    const resolved = this.resolveSafe(path);
    return this.fs.stat(resolved);
  }

  /**
   * Ensure standard workspace subdirectories exist.
   */
  async ensureDirectories(): Promise<void> {
    const dirs = [
      'uploads/images',
      'uploads/documents',
      'uploads/temp',
      'outputs/generated',
      'outputs/exports',
    ];

    for (const dir of dirs) {
      const resolved = `${this.basePath}/${dir}`;
      if (!(await this.fs.exists(resolved))) {
        await this.fs.mkdir(resolved);
      }
    }
  }

  /**
   * Get the upload target path for a given file category.
   */
  getUploadPath(filename: string, category: FileCategory = 'temp'): string {
    const subdir =
      category === 'images'
        ? 'uploads/images'
        : category === 'documents'
          ? 'uploads/documents'
          : category === 'generated'
            ? 'outputs/generated'
            : category === 'exports'
              ? 'outputs/exports'
              : 'uploads/temp';
    return `${subdir}/${filename}`;
  }

  getBasePath(): string {
    return this.basePath;
  }

  /**
   * Resolve a relative path within the workspace, preventing path traversal.
   * Throws YourBotError if the resolved path escapes the workspace.
   */
  resolveSafe(relativePath: string): string {
    // Normalize: remove leading slashes, collapse ../ segments
    const normalized = this.normalizePath(relativePath);

    const resolved = `${this.basePath}/${normalized}`;

    // Security check: ensure the resolved path stays within basePath
    if (!resolved.startsWith(`${this.basePath}/`) && resolved !== this.basePath) {
      this.logger.error('路径穿越拦截', { userId: this.userId, path: relativePath, resolved });
      throw new YourBotError(ERROR_CODES.VALIDATION_ERROR, 'PATH_TRAVERSAL_BLOCKED', {
        path: relativePath,
      });
    }

    return resolved;
  }

  /**
   * Normalize a path: resolve '..' and '.' segments, remove redundant slashes.
   */
  private normalizePath(path: string): string {
    // Remove leading slashes
    const cleaned = path.replace(/^\/+/, '');

    // Split into segments and resolve
    const parts = cleaned.split('/');
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        // Pop but never go above root
        if (resolved.length > 0) {
          resolved.pop();
        }
        // If resolved is empty after pop, we'd be at basePath which is fine
      } else {
        resolved.push(part);
      }
    }

    return resolved.join('/');
  }
}
