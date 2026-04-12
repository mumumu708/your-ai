import type { MediaType } from '../../shared/messaging/media-attachment.types';

export const MEDIA_SIZE_LIMITS: Record<MediaType, number> = {
  image: 6 * 1024 * 1024, // 6MB
  audio: 16 * 1024 * 1024, // 16MB (reserved)
  video: 16 * 1024 * 1024, // 16MB (reserved)
  document: 100 * 1024 * 1024, // 100MB (reserved)
};

export const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export const MAX_IMAGES_PER_MESSAGE = 5;

// Magic bytes for MIME detection
export const MIME_SIGNATURES: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  // WEBP: RIFF....WEBP
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
];

export interface MediaConfig {
  /** Vision model name (for image understanding) */
  visionModel: string;
  /** Vision API base URL (defaults to LightLLM config) */
  visionBaseUrl?: string;
  /** Vision API key (defaults to LightLLM config) */
  visionApiKey?: string;
}

export function loadMediaConfig(): MediaConfig {
  return {
    visionModel: process.env.VISION_MODEL ?? process.env.LIGHT_LLM_MODEL ?? 'gpt-4o-mini',
    visionBaseUrl: process.env.VISION_BASE_URL ?? process.env.LIGHT_LLM_BASE_URL,
    visionApiKey: process.env.VISION_API_KEY ?? process.env.LIGHT_LLM_API_KEY,
  };
}

/** Detect MIME type from buffer magic bytes */
export function detectMimeType(buffer: Buffer): string | null {
  for (const sig of MIME_SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
      // WEBP needs extra check: bytes 8-11 should be "WEBP"
      if (sig.mime === 'image/webp') {
        if (
          buffer.length >= 12 &&
          buffer[8] === 0x57 && // W
          buffer[9] === 0x45 && // E
          buffer[10] === 0x42 && // B
          buffer[11] === 0x50 // P
        ) {
          return 'image/webp';
        }
        continue;
      }
      return sig.mime;
    }
  }
  return null;
}
