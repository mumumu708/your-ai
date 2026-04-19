import { Logger } from '../../shared/logging/logger';
import type { MediaAttachment, MediaRef } from '../../shared/messaging/media-attachment.types';
import type { MediaDownloader } from './media-downloader';
import { MAX_IMAGES_PER_MESSAGE } from './media-types';
import type { MediaUnderstanding } from './media-understanding';

export interface MediaProcessorDeps {
  downloader: MediaDownloader;
  understanding: MediaUnderstanding;
}

export class MediaProcessor {
  private readonly logger = new Logger('MediaProcessor');
  private readonly downloader: MediaDownloader;
  private readonly understanding: MediaUnderstanding;

  constructor(deps: MediaProcessorDeps) {
    this.downloader = deps.downloader;
    this.understanding = deps.understanding;
  }

  setChannelResolver(
    resolver: (
      channelType: string,
    ) => import('../../shared/messaging/channel-adapter.types').IChannel | undefined,
  ): void {
    this.downloader.setChannelResolver(resolver);
  }

  setUploadsDir(dir: string): void {
    this.downloader.setUploadsDir(dir);
  }

  async processAttachments(
    attachments: MediaAttachment[],
    options?: { runUnderstanding?: boolean },
  ): Promise<MediaAttachment[]> {
    // Limit number of images per message
    const limited = attachments.slice(0, MAX_IMAGES_PER_MESSAGE);

    // 1. Download all attachments in parallel
    const downloaded = await Promise.allSettled(limited.map((a) => this.downloader.download(a)));

    const results: MediaAttachment[] = downloaded.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const original = limited[i] as MediaAttachment;
      this.logger.error('附件下载异常', {
        attachmentId: original.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return { ...original, state: 'failed' as const, error: '下载异常' };
    });

    // 2. Run understanding on downloaded image attachments
    if (options?.runUnderstanding !== false) {
      const understandingTasks = results.map(async (attachment) => {
        if (attachment.state !== 'downloaded' || attachment.mediaType !== 'image') {
          return attachment;
        }
        const description = await this.understanding.describeImage(attachment);
        return { ...attachment, state: 'processed' as const, description };
      });

      const understood = await Promise.allSettled(understandingTasks);
      return understood.map((result, i) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        return results[i] as MediaAttachment;
      });
    }

    return results;
  }

  toMediaRef(attachment: MediaAttachment): MediaRef {
    return {
      mediaType: attachment.mediaType,
      mimeType: attachment.mimeType,
      description: attachment.description ?? '[图片]',
      base64Data: attachment.base64Data,
      localPath: attachment.localPath,
    };
  }
}
