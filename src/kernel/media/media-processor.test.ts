import { describe, expect, test } from 'bun:test';
import type { MediaAttachment } from '../../shared/messaging/media-attachment.types';
import type { MediaDownloader } from './media-downloader';
import { MediaProcessor } from './media-processor';
import type { MediaUnderstanding } from './media-understanding';

function makeAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'test-media-1',
    mediaType: 'image',
    state: 'pending',
    ...overrides,
  };
}

function createMockDownloader(
  result?: Partial<MediaAttachment>,
  shouldReject = false,
): MediaDownloader {
  return {
    download: async (a: MediaAttachment) => {
      if (shouldReject) throw new Error('Download failed');
      return {
        ...a,
        state: 'downloaded' as const,
        base64Data: 'dGVzdA==',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        ...result,
      };
    },
  } as unknown as MediaDownloader;
}

function createMockUnderstanding(description = '一只猫的照片'): MediaUnderstanding {
  return {
    describeImage: async () => description,
  } as unknown as MediaUnderstanding;
}

describe('MediaProcessor', () => {
  describe('processAttachments', () => {
    test('downloads and understands image attachments', async () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding: createMockUnderstanding('一只橘猫'),
      });

      const attachments = [makeAttachment()];
      const results = await processor.processAttachments(attachments, { runUnderstanding: true });

      expect(results).toHaveLength(1);
      expect(results[0]?.state).toBe('processed');
      expect(results[0]?.description).toBe('一只橘猫');
    });

    test('handles multiple attachments in parallel', async () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding: createMockUnderstanding('描述'),
      });

      const attachments = [
        makeAttachment({ id: 'media-1' }),
        makeAttachment({ id: 'media-2' }),
        makeAttachment({ id: 'media-3' }),
      ];

      const results = await processor.processAttachments(attachments);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.state === 'processed')).toBe(true);
    });

    test('limits to MAX_IMAGES_PER_MESSAGE', async () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding: createMockUnderstanding(),
      });

      const attachments = Array.from({ length: 10 }, (_, i) =>
        makeAttachment({ id: `media-${i}` }),
      );

      const results = await processor.processAttachments(attachments);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    test('skips understanding when runUnderstanding=false', async () => {
      let understandingCalled = false;
      const understanding = {
        describeImage: async () => {
          understandingCalled = true;
          return 'should not be called';
        },
      } as unknown as MediaUnderstanding;

      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding,
      });

      const results = await processor.processAttachments([makeAttachment()], {
        runUnderstanding: false,
      });

      expect(results[0]?.state).toBe('downloaded');
      expect(understandingCalled).toBe(false);
    });

    test('gracefully handles download failure', async () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader({ state: 'failed', error: '下载失败' }),
        understanding: createMockUnderstanding(),
      });

      const results = await processor.processAttachments([makeAttachment()]);
      expect(results[0]?.state).toBe('failed');
    });

    test('gracefully handles download exception', async () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader(undefined, true),
        understanding: createMockUnderstanding(),
      });

      const results = await processor.processAttachments([makeAttachment()]);
      expect(results[0]?.state).toBe('failed');
      expect(results[0]?.error).toBe('下载异常');
    });

    test('skips understanding for failed downloads', async () => {
      let understandingCalled = false;
      const understanding = {
        describeImage: async () => {
          understandingCalled = true;
          return 'description';
        },
      } as unknown as MediaUnderstanding;

      const processor = new MediaProcessor({
        downloader: createMockDownloader({ state: 'failed', error: 'fail' }),
        understanding,
      });

      await processor.processAttachments([makeAttachment()]);
      expect(understandingCalled).toBe(false);
    });

    test('skips understanding for non-image media types', async () => {
      let understandingCalled = false;
      const understanding = {
        describeImage: async () => {
          understandingCalled = true;
          return 'description';
        },
      } as unknown as MediaUnderstanding;

      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding,
      });

      const attachment = makeAttachment({ mediaType: 'audio' });
      await processor.processAttachments([attachment]);
      expect(understandingCalled).toBe(false);
    });
  });

  describe('toMediaRef', () => {
    test('converts attachment to MediaRef', () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding: createMockUnderstanding(),
      });

      const attachment = makeAttachment({
        state: 'processed',
        mimeType: 'image/png',
        description: '一张风景图',
        base64Data: 'abc123',
      });

      const ref = processor.toMediaRef(attachment);
      expect(ref.mediaType).toBe('image');
      expect(ref.mimeType).toBe('image/png');
      expect(ref.description).toBe('一张风景图');
      expect(ref.base64Data).toBe('abc123');
    });

    test('uses default description when none provided', () => {
      const processor = new MediaProcessor({
        downloader: createMockDownloader(),
        understanding: createMockUnderstanding(),
      });

      const attachment = makeAttachment({ state: 'downloaded' });
      const ref = processor.toMediaRef(attachment);
      expect(ref.description).toBe('[图片]');
    });
  });
});
