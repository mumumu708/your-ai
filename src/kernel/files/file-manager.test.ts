import { describe, expect, test } from 'bun:test';
import { FileManager, type FileManagerOps } from './file-manager';

function createMockOps(): {
  ops: FileManagerOps;
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const ops: FileManagerOps = {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, content) => {
      files.set(path, typeof content === 'string' ? content : content.toString());
    },
    exists: async (path) => files.has(path) || dirs.has(path),
    mkdir: async (path) => {
      dirs.add(path);
    },
    unlink: async (path) => {
      files.delete(path);
    },
    rmdir: async (path) => {
      dirs.delete(path);
    },
    readdir: async (_path) => [
      { name: 'file.txt', isDirectory: false, size: 100, modifiedAt: 1000 },
      { name: 'subdir', isDirectory: true, size: 0, modifiedAt: 2000 },
    ],
    stat: async (path) => ({
      size: files.get(path)?.length ?? 0,
      isDirectory: dirs.has(path),
      modifiedAt: Date.now(),
    }),
    rename: async (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content !== undefined) {
        files.set(newPath, content);
        files.delete(oldPath);
      }
    },
  };

  return { ops, files, dirs };
}

describe('FileManager', () => {
  const BASE = '/user-space/user_001/workspace';

  describe('path security', () => {
    test('should resolve normal paths within workspace', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      expect(fm.resolveSafe('uploads/test.txt')).toBe(`${BASE}/uploads/test.txt`);
      expect(fm.resolveSafe('outputs/generated/report.pdf')).toBe(
        `${BASE}/outputs/generated/report.pdf`,
      );
    });

    test('should block path traversal with ../', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      // ../../etc/passwd should be normalized to empty path (stays in workspace)
      // The normalization prevents going above basePath
      const resolved = fm.resolveSafe('../../etc/passwd');
      expect(resolved).toBe(`${BASE}/etc/passwd`);
    });

    test('should block path traversal that escapes via leading /', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      // Leading slashes are stripped
      const resolved = fm.resolveSafe('/etc/passwd');
      expect(resolved).toBe(`${BASE}/etc/passwd`);
    });

    test('should handle . and empty segments', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      expect(fm.resolveSafe('./uploads/./test.txt')).toBe(`${BASE}/uploads/test.txt`);
      expect(fm.resolveSafe('uploads//test.txt')).toBe(`${BASE}/uploads/test.txt`);
    });

    test('should handle deep traversal attempts', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      // Multiple ../ should never go above workspace root
      const resolved = fm.resolveSafe('../../../../../../../etc/shadow');
      expect(resolved.startsWith(BASE)).toBe(true);
    });
  });

  describe('file operations', () => {
    test('should read a file', async () => {
      const { ops, files } = createMockOps();
      files.set(`${BASE}/test.txt`, 'hello world');
      const fm = new FileManager('user_001', BASE, ops);

      const content = await fm.readFile('test.txt');
      expect(content).toBe('hello world');
    });

    test('should write a file', async () => {
      const { ops, files } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      await fm.writeFile('uploads/test.txt', 'new content');
      expect(files.get(`${BASE}/uploads/test.txt`)).toBe('new content');
    });

    test('should create parent directory when writing', async () => {
      const { ops, files, dirs } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      await fm.writeFile('uploads/new/file.txt', 'data');
      expect(dirs.has(`${BASE}/uploads/new`)).toBe(true);
      expect(files.get(`${BASE}/uploads/new/file.txt`)).toBe('data');
    });

    test('should delete a file', async () => {
      const { ops, files } = createMockOps();
      files.set(`${BASE}/temp.txt`, 'temp');
      const fm = new FileManager('user_001', BASE, ops);

      await fm.deleteFile('temp.txt');
      expect(files.has(`${BASE}/temp.txt`)).toBe(false);
    });

    test('should list a directory', async () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      const entries = await fm.listDirectory('uploads');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ name: 'file.txt', type: 'file', size: 100, modifiedAt: 1000 });
      expect(entries[1]).toEqual({ name: 'subdir', type: 'directory', size: 0, modifiedAt: 2000 });
    });

    test('should move a file', async () => {
      const { ops, files } = createMockOps();
      files.set(`${BASE}/uploads/temp/file.txt`, 'content');
      const fm = new FileManager('user_001', BASE, ops);

      await fm.moveFile('uploads/temp/file.txt', 'uploads/documents/file.txt');
      expect(files.has(`${BASE}/uploads/temp/file.txt`)).toBe(false);
      expect(files.get(`${BASE}/uploads/documents/file.txt`)).toBe('content');
    });

    test('should stat a file', async () => {
      const { ops, files } = createMockOps();
      files.set(`${BASE}/test.txt`, 'hello');
      const fm = new FileManager('user_001', BASE, ops);

      const info = await fm.stat('test.txt');
      expect(info.size).toBe(5);
      expect(info.isDirectory).toBe(false);
    });

    test('should check file existence', async () => {
      const { ops, files } = createMockOps();
      files.set(`${BASE}/exists.txt`, 'yes');
      const fm = new FileManager('user_001', BASE, ops);

      expect(await fm.exists('exists.txt')).toBe(true);
      expect(await fm.exists('nope.txt')).toBe(false);
    });
  });

  describe('directory structure', () => {
    test('should ensure standard workspace directories', async () => {
      const { ops, dirs } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      await fm.ensureDirectories();

      expect(dirs.has(`${BASE}/uploads/images`)).toBe(true);
      expect(dirs.has(`${BASE}/uploads/documents`)).toBe(true);
      expect(dirs.has(`${BASE}/uploads/temp`)).toBe(true);
      expect(dirs.has(`${BASE}/outputs/generated`)).toBe(true);
      expect(dirs.has(`${BASE}/outputs/exports`)).toBe(true);
    });

    test('should return the base workspace path', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      expect(fm.getBasePath()).toBe(BASE);
    });

    test('should return correct upload paths by category', () => {
      const { ops } = createMockOps();
      const fm = new FileManager('user_001', BASE, ops);

      expect(fm.getUploadPath('photo.jpg', 'images')).toBe('uploads/images/photo.jpg');
      expect(fm.getUploadPath('report.pdf', 'documents')).toBe('uploads/documents/report.pdf');
      expect(fm.getUploadPath('output.csv', 'exports')).toBe('outputs/exports/output.csv');
      expect(fm.getUploadPath('random.bin')).toBe('uploads/temp/random.bin');
    });
  });
});
