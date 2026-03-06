import { Logger } from '../../shared/logging/logger';

// ── Types ──────────────────────────────────────────────────────────────────

export interface EncryptedData {
  ciphertext: string; // base64-encoded
  iv: string; // base64-encoded
  algorithm: 'AES-256-GCM';
  tag: string; // base64-encoded auth tag
}

export interface CryptoManagerConfig {
  /** Master key in hex (64 hex chars = 32 bytes). If omitted, uses env YOURBOT_MASTER_KEY. */
  masterKeyHex?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ── CryptoManager ──────────────────────────────────────────────────────────

/**
 * Encrypts and decrypts sensitive data using AES-256-GCM.
 * Derives per-user keys from a master key via HKDF.
 */
export class CryptoManager {
  private readonly logger = new Logger('CryptoManager');
  private masterKeyBytes: Uint8Array | null = null;
  private readonly config: CryptoManagerConfig;

  constructor(config: CryptoManagerConfig = {}) {
    this.config = config;
  }

  /**
   * Get or lazily initialize the master key bytes.
   */
  private getMasterKey(): Uint8Array {
    if (this.masterKeyBytes) return this.masterKeyBytes;

    const hex = this.config.masterKeyHex ?? process.env.YOURBOT_MASTER_KEY;
    if (!hex || hex.length !== 64) {
      throw new Error(
        'Master key must be 64 hex characters (32 bytes). Set YOURBOT_MASTER_KEY or pass masterKeyHex.',
      );
    }
    this.masterKeyBytes = hexToBytes(hex);
    return this.masterKeyBytes;
  }

  /**
   * Derive a per-user encryption key using HKDF (SHA-256).
   */
  async deriveKey(userId: string): Promise<CryptoKey> {
    const masterBytes = this.getMasterKey();

    const baseKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(masterBytes),
      'HKDF',
      false,
      ['deriveKey'],
    );

    const encoder = new TextEncoder();
    const salt = encoder.encode('yourbot-v1');
    const info = encoder.encode(`user:${userId}`);

    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * Encrypt a string for a specific user.
   */
  async encrypt(data: string, userId: string): Promise<EncryptedData> {
    const key = await this.deriveKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(data);

    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    // AES-GCM appends a 16-byte auth tag to the ciphertext
    const encryptedBytes = new Uint8Array(encrypted);
    const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tagBytes = encryptedBytes.slice(encryptedBytes.length - 16);

    return {
      ciphertext: toBase64(ciphertextBytes),
      iv: toBase64(iv),
      algorithm: 'AES-256-GCM',
      tag: toBase64(tagBytes),
    };
  }

  /**
   * Decrypt data for a specific user.
   */
  async decrypt(encrypted: EncryptedData, userId: string): Promise<string> {
    const key = await this.deriveKey(userId);
    const iv = fromBase64(encrypted.iv);
    const ciphertext = fromBase64(encrypted.ciphertext);
    const tag = fromBase64(encrypted.tag);

    // Reconstruct the combined buffer (ciphertext + tag) that AES-GCM expects
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(combined),
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Generate a random master key (hex string).
   */
  static generateMasterKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
