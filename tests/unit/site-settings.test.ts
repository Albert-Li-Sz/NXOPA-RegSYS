import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../../apps/server/src/config.js', () => ({
  config: { publicUrl: 'https://public.example.test', production: true },
}));
vi.mock('../../apps/server/src/db.js', () => ({ db: { setting: { findUnique } } }));
import {
  validatePublicUrl,
  validateTrustedOrigins,
  siteSettings,
  secureCookies,
} from '../../apps/server/src/site-settings.js';

beforeEach(() => {
  findUnique.mockResolvedValue(null);
  vi.stubEnv('TRUSTED_MANAGEMENT_ORIGINS', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('trusted entry URLs', () => {
  it('normalizes and deduplicates complete HTTP and HTTPS origins', () => {
    expect(
      validateTrustedOrigins([
        ' https://PUBLIC.example.test:443/ ',
        'https://public.example.test',
        'http://192.168.1.10:8080/',
        'http://[fd00::1]:8080',
      ]),
    ).toEqual(['https://public.example.test', 'http://192.168.1.10:8080', 'http://[fd00::1]:8080']);
    expect(validatePublicUrl('http://localhost:8080/')).toBe('http://localhost:8080');
  });
  it('rejects wildcard, credential, path, parameter and malformed origins', () => {
    for (const value of [
      '',
      '*',
      'https://*.example.test',
      'ftp://example.test',
      'https://user:secret@example.test',
      'https://example.test/admin',
      'https://example.test?redirect=1',
      'https://example.test#fragment',
      'https://bad_host.example.test',
      'http://example.test:0',
      'http://example.test:65536',
      'https://example .test',
    ])
      expect(() => validateTrustedOrigins([value]), value).toThrow('信任来源');
  });
  it('defaults old settings to an empty additional origin list', async () => {
    findUnique.mockResolvedValue({ value: { name: '现有站点' }, version: 3 });
    expect(await siteSettings()).toMatchObject({
      name: '现有站点',
      publicUrl: 'https://public.example.test',
      trustedOrigins: [],
      version: 3,
    });
  });
});

describe('mixed internal HTTP and public HTTPS sessions', () => {
  const request = (host: string, secure = false) => ({
    secure,
    protocol: secure ? 'https' : 'http',
    get: () => host,
  });
  it('allows a non-Secure cookie only for an explicitly trusted HTTP entry', async () => {
    findUnique.mockResolvedValue({
      value: { trustedOrigins: ['http://192.168.1.10:8080'] },
      version: 1,
    });
    expect(await secureCookies(request('192.168.1.10:8080'))).toBe(false);
    expect(await secureCookies(request('192.168.1.10:8081'))).toBe(true);
    expect(await secureCookies(request('unlisted.example.test'))).toBe(true);
    expect(await secureCookies(request('192.168.1.10:8080', true))).toBe(true);
  });
  it('also honors explicit environment HTTP entries without relaxing HTTPS', async () => {
    vi.stubEnv('TRUSTED_MANAGEMENT_ORIGINS', 'https://other.example.test,http://internal:8080');
    expect(await secureCookies(request('internal:8080'))).toBe(false);
    expect(await secureCookies(request('internal:8080', true))).toBe(true);
    expect(await secureCookies(request('other.example.test'))).toBe(true);
  });
});
