import { Logger } from '../../shared/logging/logger';
import type { IChannel } from '../../shared/messaging/channel-adapter.types';
import type { MediaAttachment } from '../../shared/messaging/media-attachment.types';
import { MEDIA_SIZE_LIMITS, SUPPORTED_IMAGE_MIMES, detectMimeType } from './media-types';

export interface MediaDownloaderDeps {
  channelResolver?: (channelType: string) => IChannel | undefined;
}

export class MediaDownloader {
  private readonly logger = new Logger('MediaDownloader');
  private readonly deps: MediaDownloaderDeps;

  constructor(deps: MediaDownloaderDeps) {
    this.deps = deps;
  }

  async download(attachment: MediaAttachment): Promise<MediaAttachment> {
    try {
      const buffer = await this.fetchBuffer(attachment);
      if (!buffer) {
        return { ...attachment, state: 'failed', error: '无法获取媒体数据' };
      }

      // Size check
      const sizeLimit = MEDIA_SIZE_LIMITS[attachment.mediaType];
      if (buffer.length > sizeLimit) {
        return {
          ...attachment,
          state: 'failed',
          error: `文件大小 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过限制 ${(sizeLimit / 1024 / 1024).toFixed(0)}MB`,
        };
      }

      // MIME detection via magic bytes
      const detectedMime = detectMimeType(buffer);
      if (attachment.mediaType === 'image') {
        if (!detectedMime || !SUPPORTED_IMAGE_MIMES.has(detectedMime)) {
          return {
            ...attachment,
            state: 'failed',
            error: `不支持的图片格式: ${detectedMime ?? 'unknown'}`,
          };
        }
      }

      const base64Data = buffer.toString('base64');
      return {
        ...attachment,
        state: 'downloaded',
        base64Data,
        mimeType: detectedMime ?? attachment.mimeType,
        sizeBytes: buffer.length,
      };
    } catch (error) {
      this.logger.error('媒体下载失败', {
        attachmentId: attachment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...attachment,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchBuffer(attachment: MediaAttachment): Promise<Buffer | null> {
    const ref = attachment.sourceRef;
    if (!ref) return null;

    switch (ref.channel) {
      case 'telegram': {
        const channel = this.deps.channelResolver?.('telegram');
        if (!channel?.getFileBuffer) {
          this.logger.warn('Telegram 通道未配置 getFileBuffer');
          return null;
        }
        return channel.getFileBuffer(ref.fileId);
      }
      case 'feishu': {
        const channel = this.deps.channelResolver?.('feishu');
        if (!channel?.downloadFile) {
          this.logger.warn('Feishu 通道未配置 downloadFile');
          return null;
        }
        return channel.downloadFile(ref.messageId, ref.fileKey);
      }
      case 'web':
      case 'api': {
        if (!ref.base64) return null;
        return Buffer.from(ref.base64, 'base64');
      }
      default:
        return null;
    }
  }
}
