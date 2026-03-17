export type MediaType = 'image' | 'audio' | 'video' | 'document';
export type MediaState = 'pending' | 'downloaded' | 'processed' | 'failed';

export interface MediaAttachment {
  id: string;
  mediaType: MediaType;
  state: MediaState;
  mimeType?: string;
  sizeBytes?: number;
  sourceRef?: MediaSourceRef;
  localPath?: string;
  base64Data?: string;
  description?: string;
  error?: string;
}

export type MediaSourceRef =
  | { channel: 'telegram'; fileId: string; fileUniqueId?: string }
  | { channel: 'feishu'; messageId: string; fileKey: string }
  | { channel: 'web'; base64: string; fileName?: string }
  | { channel: 'api'; base64: string; fileName?: string };

/** Lightweight reference stored in ConversationMessage (no full base64) */
export interface MediaRef {
  mediaType: MediaType;
  mimeType?: string;
  description: string;
  base64Data?: string; // Only held temporarily for current message, cleared after LLM call
  localPath?: string;
}
