import { describe, expect, test } from 'bun:test';
import {
  MEDIA_SIZE_LIMITS,
  SUPPORTED_IMAGE_MIMES,
  detectMimeType,
  loadMediaConfig,
} from './media-types';

describe('media-types', () => {
  describe('MEDIA_SIZE_LIMITS', () => {
    test('image limit is 6MB', () => {
      expect(MEDIA_SIZE_LIMITS.image).toBe(6 * 1024 * 1024);
    });

    test('audio limit is 16MB', () => {
      expect(MEDIA_SIZE_LIMITS.audio).toBe(16 * 1024 * 1024);
    });

    test('video limit is 16MB', () => {
      expect(MEDIA_SIZE_LIMITS.video).toBe(16 * 1024 * 1024);
    });

    test('document limit is 100MB', () => {
      expect(MEDIA_SIZE_LIMITS.document).toBe(100 * 1024 * 1024);
    });
  });

  describe('SUPPORTED_IMAGE_MIMES', () => {
    test('supports jpeg, png, gif, webp', () => {
      expect(SUPPORTED_IMAGE_MIMES.has('image/jpeg')).toBe(true);
      expect(SUPPORTED_IMAGE_MIMES.has('image/png')).toBe(true);
      expect(SUPPORTED_IMAGE_MIMES.has('image/gif')).toBe(true);
      expect(SUPPORTED_IMAGE_MIMES.has('image/webp')).toBe(true);
    });

    test('does not support other types', () => {
      expect(SUPPORTED_IMAGE_MIMES.has('image/bmp')).toBe(false);
      expect(SUPPORTED_IMAGE_MIMES.has('image/svg+xml')).toBe(false);
    });
  });

  describe('detectMimeType', () => {
    test('detects JPEG', () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
      expect(detectMimeType(buf)).toBe('image/jpeg');
    });

    test('detects PNG', () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(detectMimeType(buf)).toBe('image/png');
    });

    test('detects GIF', () => {
      const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      expect(detectMimeType(buf)).toBe('image/gif');
    });

    test('detects WEBP', () => {
      // RIFF....WEBP
      const buf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      expect(detectMimeType(buf)).toBe('image/webp');
    });

    test('returns null for RIFF that is not WEBP', () => {
      // RIFF....WAVE (not WEBP)
      const buf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      ]);
      expect(detectMimeType(buf)).toBeNull();
    });

    test('returns null for short RIFF buffer', () => {
      const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]);
      expect(detectMimeType(buf)).toBeNull();
    });

    test('returns null for unknown format', () => {
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      expect(detectMimeType(buf)).toBeNull();
    });

    test('returns null for empty buffer', () => {
      const buf = Buffer.alloc(0);
      expect(detectMimeType(buf)).toBeNull();
    });
  });

  describe('loadMediaConfig', () => {
    test('returns default config when env vars not set', () => {
      const config = loadMediaConfig();
      expect(config.visionModel).toBeDefined();
      expect(typeof config.visionModel).toBe('string');
    });
  });
});
