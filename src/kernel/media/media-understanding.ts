import { Logger } from '../../shared/logging/logger';
import type { MediaAttachment } from '../../shared/messaging/media-attachment.types';
import type { LightLLMClient } from '../agents/light-llm-client';
import { type MediaConfig, loadMediaConfig } from './media-types';

export interface MediaUnderstandingDeps {
  lightLLM: LightLLMClient | null;
  config?: MediaConfig;
}

export class MediaUnderstanding {
  private readonly logger = new Logger('MediaUnderstanding');
  private readonly config: MediaConfig;
  private readonly lightLLM: LightLLMClient | null;

  constructor(deps: MediaUnderstandingDeps) {
    this.config = deps.config ?? loadMediaConfig();
    this.lightLLM = deps.lightLLM;
  }

  async describeImage(attachment: MediaAttachment): Promise<string> {
    if (!attachment.base64Data || !attachment.mimeType) {
      return '[图片]';
    }

    if (!this.lightLLM) {
      this.logger.warn('LightLLM 未配置，无法进行图片理解');
      return '[图片]';
    }

    try {
      const dataUrl = `data:${attachment.mimeType};base64,${attachment.base64Data}`;
      const response = await this.lightLLM.complete({
        model: this.config.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '请简要描述这张图片的内容。如有文字请完整转录。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        maxTokens: 512,
        temperature: 0.3,
      });

      return response.content || '[图片]';
    } catch (error) {
      this.logger.error('图片理解失败', {
        attachmentId: attachment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return '[图片]';
    }
  }
}
