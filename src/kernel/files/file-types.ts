export type FileCategory = 'images' | 'documents' | 'temp' | 'generated' | 'exports';

export type UserTier = 'free' | 'pro' | 'enterprise';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt?: number;
  category?: FileCategory;
}

export interface FileMeta {
  id: string;
  userId: string;
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  category: FileCategory;
  uploadedAt: number;
  channel: string;
}

export interface QuotaConfig {
  maxStorageBytes: number;
  maxFileSizeBytes: number;
  maxFileCount: number;
}

export const QUOTA_BY_TIER: Record<UserTier, QuotaConfig> = {
  free: {
    maxStorageBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    maxFileSizeBytes: 20 * 1024 * 1024, // 20 MB
    maxFileCount: 1000,
  },
  pro: {
    maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    maxFileSizeBytes: 100 * 1024 * 1024, // 100 MB
    maxFileCount: 10000,
  },
  enterprise: {
    maxStorageBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    maxFileSizeBytes: 500 * 1024 * 1024, // 500 MB
    maxFileCount: Number.POSITIVE_INFINITY,
  },
};

export interface ChannelUploadLimits {
  maxSizeBytes: number;
  allowedFormats: string[];
}

export const CHANNEL_UPLOAD_LIMITS: Record<string, ChannelUploadLimits> = {
  feishu: {
    maxSizeBytes: 20 * 1024 * 1024,
    allowedFormats: [
      'image/*',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats*',
    ],
  },
  telegram: {
    maxSizeBytes: 50 * 1024 * 1024,
    allowedFormats: ['*/*'],
  },
  web: {
    maxSizeBytes: 100 * 1024 * 1024,
    allowedFormats: ['*/*'],
  },
};

// Extensions that are never allowed to be uploaded
export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.pif',
  '.sh',
  '.bash',
  '.csh',
  '.ksh',
  '.msi',
  '.dll',
  '.sys',
  '.drv',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
]);
