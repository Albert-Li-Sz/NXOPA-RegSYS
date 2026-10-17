import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { createServer } from 'node:http';
vi.mock('../../apps/server/src/config.js', () => ({
  config: { production: false, allowPrivate: false },
}));
import { config } from '../../apps/server/src/config.js';
import { integrationTarget, integrationRequest } from '../../apps/server/src/integration-http.js';
afterEach(() => {
  vi.restoreAllMocks();
  config.allowPrivate = false;
});
describe('integration destination boundary', () => {
  it.each([
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '100.64.0.1',
    '169.254.169.254',
    '198.18.0.1',
    '::1',
    'fd00::1',
  ])('rejects non-public DNS answers including %s', async (address) => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address, family: address.includes(':') ? 6 : 4 },
    ] as never);
    await expect(integrationTarget('http://platform.example.test')).rejects.toThrow('公网范围');
  });
  it('rejects a mixed public/private answer set', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(integrationTarget('http://platform.example.test')).rejects.toThrow('公网范围');
  });
  it('pins the validated destination, preserves Host, and returns redirects without following them', async () => {
    config.allowPrivate = true;
    const hosts: string[] = [];
    const server = createServer((req, res) => {
      hosts.push(req.headers.host!);
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    try {
      const response = await integrationRequest(
        `http://private-platform.test:${address.port}/probe`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(response.status).toBe(302);
      expect(hosts).toEqual([`private-platform.test:${address.port}`]);
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
