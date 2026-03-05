import { BLOCKED_EXTENSIONS, CHANNEL_UPLOAD_LIMITS } from './file-types';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates files before upload/storage.
 * Enforces extension blocklist, channel-specific limits, and size constraints.
 */
export class FileValidator {
  /**
   * Validate a file for upload.
   */
  validate(filename: string, sizeBytes: number, channel: string): ValidationResult {
    // Check blocked extensions
    const extCheck = this.checkExtension(filename);
    if (!extCheck.valid) return extCheck;

    // Check channel-specific limits
    const channelCheck = this.checkChannelLimits(filename, sizeBytes, channel);
    if (!channelCheck.valid) return channelCheck;

    return { valid: true };
  }

  /**
   * Check if a file extension is blocked (executable prevention).
   */
  checkExtension(filename: string): ValidationResult {
    const ext = this.getExtension(filename);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        reason: `文件类型 '${ext}' 不允许上传`,
      };
    }
    return { valid: true };
  }

  /**
   * Check channel-specific upload limits.
   */
  checkChannelLimits(_filename: string, sizeBytes: number, channel: string): ValidationResult {
    const limits = CHANNEL_UPLOAD_LIMITS[channel];
    if (!limits) {
      return { valid: true }; // Unknown channel, allow
    }

    if (sizeBytes > limits.maxSizeBytes) {
      const maxMB = Math.round(limits.maxSizeBytes / (1024 * 1024));
      return {
        valid: false,
        reason: `${channel} 通道文件大小限制为 ${maxMB}MB`,
      };
    }

    return { valid: true };
  }

  /**
   * Categorize a file based on its extension.
   */
  categorize(filename: string): 'images' | 'documents' | 'temp' {
    const ext = this.getExtension(filename);

    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico']);
    const docExts = new Set([
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.txt',
      '.csv',
      '.md',
      '.json',
      '.xml',
      '.yaml',
      '.yml',
    ]);

    if (imageExts.has(ext)) return 'images';
    if (docExts.has(ext)) return 'documents';
    return 'temp';
  }

  /**
   * Extract lowercase file extension including the dot.
   */
  getExtension(filename: string): string {
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx < 0) return '';
    return filename.slice(dotIdx).toLowerCase();
  }
}
