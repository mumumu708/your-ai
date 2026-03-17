import { describe, expect, test } from 'bun:test';
import type { MediaAttachment } from '../../shared/messaging/media-attachment.types';
import type { LightLLMClient } from '../agents/light-llm-client';
import { MediaUnderstanding } from './media-understanding';

function makeAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'test-media-1',
    mediaType: 'image',
    state: 'downloaded',
    mimeType: 'image/jpeg',
    base64Data: '/9j/4AAQSkZJRg==', // Minimal JPEG base64
    ...overrides,
  };
}

function createMockLightLLM(response = '一只猫坐在桌子上'): LightLLMClient {
  return {
    complete: async () => ({
      content: response,
      model: 'gpt-4o-mini',
      usage: { promptTokens: 100, completionTokens: 20, totalCost: 0.001 },
    }),
  } as unknown as LightLLMClient;
}

describe('MediaUnderstanding', () => {
  test('describes image using vision API', async () => {
    const lightLLM = createMockLightLLM('一只可爱的橘猫');
    const understanding = new MediaUnderstanding({
      lightLLM,
      config: { visionModel: 'gpt-4o-mini' },
    });

    const result = await understanding.describeImage(makeAttachment());
    expect(result).toBe('一只可爱的橘猫');
  });

  test('returns placeholder when lightLLM is null', async () => {
    const understanding = new MediaUnderstanding({
      lightLLM: null,
      config: { visionModel: 'gpt-4o-mini' },
    });

    const result = await understanding.describeImage(makeAttachment());
    expect(result).toBe('[图片]');
  });

  test('returns placeholder when base64Data is missing', async () => {
    const lightLLM = createMockLightLLM();
    const understanding = new MediaUnderstanding({
      lightLLM,
      config: { visionModel: 'gpt-4o-mini' },
    });

    const result = await understanding.describeImage(makeAttachment({ base64Data: undefined }));
    expect(result).toBe('[图片]');
  });

  test('returns placeholder when mimeType is missing', async () => {
    const lightLLM = createMockLightLLM();
    const understanding = new MediaUnderstanding({
      lightLLM,
      config: { visionModel: 'gpt-4o-mini' },
    });

    const result = await understanding.describeImage(makeAttachment({ mimeType: undefined }));
    expect(result).toBe('[图片]');
  });

  test('returns placeholder when vision API fails', async () => {
    const lightLLM = {
      complete: async () => {
        throw new Error('API timeout');
      },
    } as unknown as LightLLMClient;

    const understanding = new MediaUnderstanding({
      lightLLM,
      config: { visionModel: 'gpt-4o-mini' },
    });

    const result = await understanding.describeImage(makeAttachment());
    expect(result).toBe('[图片]');
  });

  test('returns placeholder when vision API returns empty string', async () => {
    const lightLLM = createMockLightLLM('');
    const understanding = new MediaUnderstanding({
      lightLLM,
      config: { visionModel: 'gpt-4o-mini' },
    });

    const result = await understanding.describeImage(makeAttachment());
    expect(result).toBe('[图片]');
  });

  test('passes correct model to lightLLM.complete', async () => {
    let capturedModel: string | undefined;
    const lightLLM = {
      complete: async (req: { model?: string }) => {
        capturedModel = req.model;
        return {
          content: 'description',
          model: 'test-model',
          usage: { promptTokens: 0, completionTokens: 0, totalCost: 0 },
        };
      },
    } as unknown as LightLLMClient;

    const understanding = new MediaUnderstanding({
      lightLLM,
      config: { visionModel: 'custom-vision-model' },
    });

    await understanding.describeImage(makeAttachment());
    expect(capturedModel).toBe('custom-vision-model');
  });
});
