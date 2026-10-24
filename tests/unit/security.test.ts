import { describe, expect, it, vi } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
// Cryptography and address policy tests must not load local secrets or create a DB client.
vi.mock('../../apps/server/src/config.js', () => ({
  config: { encryptionKey: '12'.repeat(32), production: false },
}));
vi.mock('../../apps/server/src/db.js', () => ({ db: {}, registrationInclude: {} }));
import {
  encrypt,
  decrypt,
  secretKey,
  otpHash,
  checkOtp,
  hmac,
} from '../../apps/server/src/security.js';
import { config } from '../../apps/server/src/config.js';

describe('secret compatibility and separation', () => {
  it('uses separate keys and authenticated contexts', () => {
    expect(secretKey('csrf:v2')).not.toBe(secretKey('otp:v2'));
    const value = encrypt('private value', 'mail-password');
    expect(value.startsWith('v2.')).toBe(true);
    expect(decrypt(value, 'mail-password')).toBe('private value');
    expect(() => decrypt(value, 'other-field')).toThrow('加密配置无法读取');
  });
  it('reads historical ciphertext without rewriting it', () => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
    const body = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()]);
    const encoded = [
      iv.toString('hex'),
      body.toString('hex'),
      cipher.getAuthTag().toString('hex'),
    ].join('.');
    expect(decrypt(encoded)).toBe('legacy');
  });
  it('rejects malformed or tampered ciphertext with a controlled error', () => {
    const original = encrypt('secret');
    const tampered = original.slice(0, -1) + (original.endsWith('0') ? '1' : '0');
    for (const value of ['a.b', 'v2.a.b.c', '00.00.00', tampered])
      expect(() => decrypt(value)).toThrow('加密配置无法读取');
  });
  it('supports existing codes while writing derived-key codes', () => {
    const body = 'token:123456';
    expect(checkOtp(otpHash(body), body)).toBe(true);
    expect(checkOtp(hmac(config.encryptionKey, body), body)).toBe(true);
    expect(checkOtp(otpHash(body), 'token:123457')).toBe(false);
  });
});
