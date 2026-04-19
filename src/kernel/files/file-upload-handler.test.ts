import { describe, expect, mock, test } from 'bun:test';
import type { UserConfigLoader } from '../prompt/user-config-loader';
import { FileUploadHandler } from './file-upload-handler';

function createMockUCL(): UserConfigLoader {
  return {
    writeConfig: mock(async () => {}),
  } as unknown as UserConfigLoader;
}

describe('FileUploadHandler', () => {
  const handler = new FileUploadHandler();

  describe('isUserProfileUpload', () => {
    test('returns true for user.md', () => {
      expect(handler.isUserProfileUpload('user.md')).toBe(true);
      expect(handler.isUserProfileUpload('USER.MD')).toBe(true);
    });

    test('returns true for user.txt', () => {
      expect(handler.isUserProfileUpload('user.txt')).toBe(true);
      expect(handler.isUserProfileUpload('USER.TXT')).toBe(true);
    });

    test('returns false for other files', () => {
      expect(handler.isUserProfileUpload('readme.md')).toBe(false);
      expect(handler.isUserProfileUpload('config.json')).toBe(false);
    });
  });

  describe('processUserMdUpload', () => {
    test('writes valid .md file', async () => {
      const ucl = createMockUCL();
      const buffer = Buffer.from('# My Profile\nI am a developer.');
      const result = await handler.processUserMdUpload(buffer, 'user.md', ucl);
      expect(result).toContain('成功');
      expect(ucl.writeConfig).toHaveBeenCalled();
    });

    test('rejects unsupported file extensions', async () => {
      const ucl = createMockUCL();
      const buffer = Buffer.from('content');
      const result = await handler.processUserMdUpload(buffer, 'user.json', ucl);
      expect(result).toContain('不支持');
    });

    test('rejects files without extension', async () => {
      const ucl = createMockUCL();
      const buffer = Buffer.from('content');
      const result = await handler.processUserMdUpload(buffer, 'userfile', ucl);
      expect(result).toContain('不支持');
    });

    test('rejects files exceeding max size', async () => {
      const ucl = createMockUCL();
      const buffer = Buffer.alloc(200 * 1024); // 200KB
      const result = await handler.processUserMdUpload(buffer, 'user.md', ucl);
      expect(result).toContain('过大');
    });

    test('rejects empty files', async () => {
      const ucl = createMockUCL();
      const buffer = Buffer.from('   ');
      const result = await handler.processUserMdUpload(buffer, 'user.md', ucl);
      expect(result).toContain('为空');
    });

    test('accepts .txt files', async () => {
      const ucl = createMockUCL();
      const buffer = Buffer.from('some content');
      const result = await handler.processUserMdUpload(buffer, 'user.txt', ucl);
      expect(result).toContain('成功');
    });
  });
});
