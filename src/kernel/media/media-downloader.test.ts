import { describe, expect, test } from 'bun:test';
import type { IChannel } from '../../shared/messaging/channel-adapter.types';
import type { MediaAttachment } from '../../shared/messaging/media-attachment.types';
import { MediaDownloader } from './media-downloader';

// A small valid JPEG (magic bytes + padding)
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);
// A small valid PNG (magic bytes + padding)
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array(100).fill(0)]);

function makeAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'test-media-1',
    mediaType: 'image',
    state: 'pending',
    ...overrides,
  };
}

describe('MediaDownloader', () => {
  describe('download — telegram', () => {
    test('downloads and validates telegram image', async () => {
      const mockChannel = {
        getFileBuffer: async () => JPEG_BYTES,
      } as unknown as IChannel;

      const downloader = new MediaDownloader({
        channelResolver: (type) => (type === 'telegram' ? mockChannel : undefined),
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'telegram', fileId: 'file123' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('downloaded');
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.base64Data).toBeDefined();
      expect(result.sizeBytes).toBe(JPEG_BYTES.length);
    });

    test('fails when telegram channel not available', async () => {
      const downloader = new MediaDownloader({
        channelResolver: () => undefined,
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'telegram', fileId: 'file123' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('无法获取媒体数据');
    });

    test('fails when getFileBuffer not implemented', async () => {
      const mockChannel = {} as unknown as IChannel;
      const downloader = new MediaDownloader({
        channelResolver: () => mockChannel,
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'telegram', fileId: 'file123' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
    });
  });

  describe('download — feishu', () => {
    test('downloads feishu image via downloadFile', async () => {
      const mockChannel = {
        downloadFile: async () => PNG_BYTES,
      } as unknown as IChannel;

      const downloader = new MediaDownloader({
        channelResolver: (type) => (type === 'feishu' ? mockChannel : undefined),
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'feishu', messageId: 'msg1', fileKey: 'key1' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('downloaded');
      expect(result.mimeType).toBe('image/png');
    });

    test('fails when feishu channel not available', async () => {
      const downloader = new MediaDownloader({
        channelResolver: () => undefined,
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'feishu', messageId: 'msg1', fileKey: 'key1' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
    });
  });

  describe('download — web/api', () => {
    test('decodes web base64 image', async () => {
      const base64 = JPEG_BYTES.toString('base64');
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'web', base64 },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('downloaded');
      expect(result.mimeType).toBe('image/jpeg');
    });

    test('decodes api base64 image', async () => {
      const base64 = PNG_BYTES.toString('base64');
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'api', base64 },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('downloaded');
      expect(result.mimeType).toBe('image/png');
    });

    test('fails when web base64 is empty', async () => {
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'web', base64: '' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
    });
  });

  describe('setChannelResolver — late binding', () => {
    test('构造时无 channelResolver → 下载失败；setChannelResolver 后 → 下载成功', async () => {
      const mockChannel = {
        downloadFile: async () => PNG_BYTES,
      } as unknown as IChannel;

      // 构造时不传 channelResolver（模拟 CentralController 初始化时序）
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'feishu', messageId: 'msg1', fileKey: 'key1' },
      });

      // 修复前的行为：channelResolver 为 undefined，下载失败
      const before = await downloader.download(attachment);
      expect(before.state).toBe('failed');

      // 延迟注入 channelResolver（模拟 setChannelResolver 调用）
      downloader.setChannelResolver((type) => (type === 'feishu' ? mockChannel : undefined));

      // 修复后的行为：channelResolver 已注入，下载成功
      const after = await downloader.download(attachment);
      expect(after.state).toBe('downloaded');
      expect(after.mimeType).toBe('image/png');
      expect(after.base64Data).toBeDefined();
    });

    test('setChannelResolver 替换已有 resolver', async () => {
      const brokenChannel = {
        downloadFile: async () => {
          throw new Error('old channel broken');
        },
      } as unknown as IChannel;
      const workingChannel = {
        downloadFile: async () => JPEG_BYTES,
      } as unknown as IChannel;

      const downloader = new MediaDownloader({
        channelResolver: () => brokenChannel,
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'feishu', messageId: 'msg1', fileKey: 'key1' },
      });

      // 旧 resolver → 下载异常
      const before = await downloader.download(attachment);
      expect(before.state).toBe('failed');

      // 替换 resolver
      downloader.setChannelResolver(() => workingChannel);

      const after = await downloader.download(attachment);
      expect(after.state).toBe('downloaded');
      expect(after.mimeType).toBe('image/jpeg');
    });
  });

  describe('disk persistence (uploadsDir)', () => {
    test('设置 uploadsDir 后下载应写磁盘并设 localPath', async () => {
      const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const uploadsDir = mkdtempSync(join(tmpdir(), 'dl-test-'));
      const base64 = JPEG_BYTES.toString('base64');

      const downloader = new MediaDownloader({ uploadsDir });

      const attachment = makeAttachment({
        sourceRef: { channel: 'web', base64 },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('downloaded');
      expect(result.localPath).toBeDefined();
      expect(existsSync(result.localPath!)).toBe(true);

      // 文件内容应与原始 buffer 一致
      const onDisk = readFileSync(result.localPath!);
      expect(onDisk.length).toBe(JPEG_BYTES.length);

      // 清理
      const { rmSync } = await import('node:fs');
      rmSync(uploadsDir, { recursive: true, force: true });
    });

    test('未设置 uploadsDir 时 localPath 为 undefined', async () => {
      const base64 = JPEG_BYTES.toString('base64');
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'web', base64 },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('downloaded');
      expect(result.localPath).toBeUndefined();
    });

    test('setUploadsDir 动态设置后生效', async () => {
      const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const uploadsDir = mkdtempSync(join(tmpdir(), 'dl-test-'));
      const base64 = PNG_BYTES.toString('base64');

      const downloader = new MediaDownloader({});

      // 第一次下载：无 uploadsDir
      const first = await downloader.download(
        makeAttachment({ id: 'a1', sourceRef: { channel: 'web', base64 } }),
      );
      expect(first.localPath).toBeUndefined();

      // 动态设置
      downloader.setUploadsDir(uploadsDir);

      // 第二次下载：有 uploadsDir
      const second = await downloader.download(
        makeAttachment({ id: 'a2', sourceRef: { channel: 'web', base64 } }),
      );
      expect(second.localPath).toBeDefined();
      expect(existsSync(second.localPath!)).toBe(true);

      rmSync(uploadsDir, { recursive: true, force: true });
    });
  });

  describe('download — validation', () => {
    test('fails for unsupported MIME type', async () => {
      // BMP header (not supported)
      const bmpBytes = Buffer.from([0x42, 0x4d, ...Array(100).fill(0)]);
      const base64 = bmpBytes.toString('base64');
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'web', base64 },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('不支持的图片格式');
    });

    test('fails for oversized file', async () => {
      // Create buffer > 6MB
      const bigBuffer = Buffer.alloc(7 * 1024 * 1024);
      // Add JPEG magic bytes
      bigBuffer[0] = 0xff;
      bigBuffer[1] = 0xd8;
      bigBuffer[2] = 0xff;
      const base64 = bigBuffer.toString('base64');
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({
        sourceRef: { channel: 'web', base64 },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('超过限制');
    });

    test('fails when sourceRef is missing', async () => {
      const downloader = new MediaDownloader({});

      const attachment = makeAttachment({ sourceRef: undefined });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
    });

    test('catches download exceptions gracefully', async () => {
      const mockChannel = {
        getFileBuffer: async () => {
          throw new Error('Network error');
        },
      } as unknown as IChannel;

      const downloader = new MediaDownloader({
        channelResolver: (type) => (type === 'telegram' ? mockChannel : undefined),
      });

      const attachment = makeAttachment({
        sourceRef: { channel: 'telegram', fileId: 'file123' },
      });

      const result = await downloader.download(attachment);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('Network error');
    });
  });
});
