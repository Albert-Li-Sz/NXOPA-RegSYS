import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request, type IncomingMessage } from 'node:http';
vi.mock('../../apps/server/src/auth.js', () => ({
  rateLimit: async () => undefined,
  user: () => ({ id: 'upload-timeout-test' }),
}));
import { BoundedUpload } from '../../apps/server/src/upload-interceptor.js';
afterEach(() => vi.restoreAllMocks());
it('destroys a timed-out multipart request before freeing its upload slot', async () => {
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: any[]) => void,
    ms: number,
    ...args: any[]
  ) => timeout(callback, ms === 120000 ? 50 : ms, ...args)) as typeof setTimeout);
  let received: IncomingMessage | undefined;
  const interceptor = new BoundedUpload();
  const server = createServer((req, res) => {
    received = req;
    Object.assign(req, { query: { purpose: 'PRIVATE' } });
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as Parameters<BoundedUpload['intercept']>[0];
    void interceptor
      .intercept(context, {
        handle: () => {
          throw new Error('Incomplete upload reached handler');
        },
      })
      .then(() => res.end('unexpected'))
      .catch(() => {
        if (!res.destroyed) res.writeHead(400).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const client = request(`http://127.0.0.1:${address.port}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'multipart/form-data; boundary=timeout',
      'Transfer-Encoding': 'chunked',
    },
  });
  client.on('error', () => undefined);
  try {
    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    client.write(
      '--timeout\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\n\r\npartial',
    );
    await closed;
    expect(received?.destroyed).toBe(true);
    expect(client.destroyed).toBe(true);
    expect(received?.socket.destroyed).toBe(true);
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
