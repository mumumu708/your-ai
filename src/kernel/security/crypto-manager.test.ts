import { describe, expect, test } from 'bun:test';
import { CryptoManager } from './crypto-manager';

// Generate a stable test key
const TEST_KEY = 'a'.repeat(64); // 32 bytes of 0xaa

describe('CryptoManager', () => {
  test('should generate a valid master key', () => {
    const key = CryptoManager.generateMasterKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  test('should encrypt and decrypt round-trip', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const plaintext = 'Hello, 世界! 🔐';
    const encrypted = await cm.encrypt(plaintext, 'user_001');

    expect(encrypted.algorithm).toBe('AES-256-GCM');
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();

    const decrypted = await cm.decrypt(encrypted, 'user_001');
    expect(decrypted).toBe(plaintext);
  });

  test('should produce different ciphertext each time (random IV)', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const plaintext = 'same data';
    const e1 = await cm.encrypt(plaintext, 'user_001');
    const e2 = await cm.encrypt(plaintext, 'user_001');

    // Different IVs → different ciphertext
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);

    // But both decrypt to the same plaintext
    expect(await cm.decrypt(e1, 'user_001')).toBe(plaintext);
    expect(await cm.decrypt(e2, 'user_001')).toBe(plaintext);
  });

  test('should derive different keys for different users', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const plaintext = 'secret';

    const encForUser1 = await cm.encrypt(plaintext, 'user_001');

    // Decrypting with different user should fail
    await expect(cm.decrypt(encForUser1, 'user_002')).rejects.toThrow();
  });

  test('should reject invalid master key length', () => {
    const cm = new CryptoManager({ masterKeyHex: 'tooshort' });
    expect(() => cm.getMasterKey()).toThrow('64 hex characters');
  });

  test('should reject missing master key', () => {
    // Ensure env is not set
    const orig = process.env.YOURBOT_MASTER_KEY;
    process.env.YOURBOT_MASTER_KEY = undefined;

    const cm = new CryptoManager();
    expect(() => cm.getMasterKey()).toThrow('Master key');

    if (orig) process.env.YOURBOT_MASTER_KEY = orig;
  });

  test('should handle empty string encryption', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const encrypted = await cm.encrypt('', 'user_001');
    const decrypted = await cm.decrypt(encrypted, 'user_001');
    expect(decrypted).toBe('');
  });

  test('should handle large data', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const largeData = 'x'.repeat(100_000);
    const encrypted = await cm.encrypt(largeData, 'user_001');
    const decrypted = await cm.decrypt(encrypted, 'user_001');
    expect(decrypted).toBe(largeData);
  });

  test('should detect tampered ciphertext', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const encrypted = await cm.encrypt('sensitive', 'user_001');

    // Tamper by flipping bits in the ciphertext bytes
    const ctBytes = Buffer.from(encrypted.ciphertext, 'base64');
    ctBytes[0] ^= 0xff;
    const tampered = { ...encrypted, ciphertext: ctBytes.toString('base64') };
    await expect(cm.decrypt(tampered, 'user_001')).rejects.toThrow();
  });

  test('should detect tampered auth tag', async () => {
    const cm = new CryptoManager({ masterKeyHex: TEST_KEY });
    const encrypted = await cm.encrypt('sensitive', 'user_001');

    // Tamper with tag
    const tagBytes = Buffer.from(encrypted.tag, 'base64');
    tagBytes[0] ^= 0xff;
    const tampered = { ...encrypted, tag: tagBytes.toString('base64') };
    await expect(cm.decrypt(tampered, 'user_001')).rejects.toThrow();
  });
});
