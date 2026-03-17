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
