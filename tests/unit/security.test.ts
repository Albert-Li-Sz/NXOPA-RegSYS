import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  encrypt,
  decrypt,
  secretKey,
  otpHash,
  checkOtp,
  hmac,
} from '../../apps/server/src/security.js';
import { config } from '../../apps/server/src/config.js';
import { publicWebhookAddress, webhookTarget } from '../../apps/server/src/webhook-http.js';

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
describe('independent webhook egress policy', () => {
  it('rejects non-public IPv4 and IPv6 addresses', () => {
    for (const value of [
      '0.0.0.0',
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '2002:7f00:1::',
    ])
      expect(publicWebhookAddress(value), value).toBe(false);
    expect(publicWebhookAddress('8.8.8.8')).toBe(true);
    expect(publicWebhookAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects a hostname if any DNS answer is private', async () => {
    await expect(
      webhookTarget('https://hooks.example.test', {
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toThrow('Webhook');
  });
  it('only explicitly approved private endpoints are admitted; metadata stays blocked', async () => {
    await expect(webhookTarget('http://127.0.0.1')).rejects.toThrow('Webhook');
    expect((await webhookTarget('http://127.0.0.1', { allowPrivate: true })).address.address).toBe(
      '127.0.0.1',
    );
    for (const url of [
      'http://169.254.169.254',
      'http://100.100.100.200',
      'http://[fd00:ec2::254]',
      'http://[fd20:ce::254]',
      'http://[::ffff:100.100.100.200]',
    ])
      await expect(webhookTarget(url, { allowPrivate: true })).rejects.toThrow('Webhook');
  });
});
