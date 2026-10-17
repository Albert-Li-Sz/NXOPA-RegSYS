import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('element-plus', () => ({ ElMessage: { error: vi.fn() } }));
vi.mock('../../apps/web/src/generated-client', () => ({ setClientCsrf: vi.fn() }));
import { api } from '../../apps/web/src/api.ts';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('write submission and retry identities', () => {
  it('releases a timed-out write and preserves its idempotency key for retry', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason)),
          ),
      )
      .mockResolvedValueOnce(new Response('{"id":"retried"}'));
    vi.stubGlobal('fetch', fetch);
    const result = expect(api('/timeout', 'POST', { title: 'draft' })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120001);
    await result;
    await expect(api('/timeout', 'POST', { title: 'draft' })).resolves.toEqual({ id: 'retried' });
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      fetch.mock.calls[1][1].headers['Idempotency-Key'],
    );
  });
  it('shares a pending identical write, then gives an intentional new action a new key', async () => {
    let complete;
    const first = new Promise((resolve) => {
      complete = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(new Response('{"id":"second"}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const a = api('/support', 'POST', { title: 'same draft' }),
      b = api('/support', 'POST', { title: 'same draft' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const key = fetch.mock.calls[0][1].headers['Idempotency-Key'];
    complete(new Response('{"id":"first"}', { status: 201 }));
    expect(await a).toEqual(await b);
    await api('/support', 'POST', { title: 'same draft' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers['Idempotency-Key']).not.toBe(key);
  });
  it('reuses the operation key when a response is lost', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Connection interrupted'))
      .mockResolvedValueOnce(new Response('{"id":"saved"}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/support/retry', 'POST', { text: 'draft' })).rejects.toThrow(
      'Connection interrupted',
    );
    await expect(api('/support/retry', 'POST', { text: 'draft' })).resolves.toEqual({
      id: 'saved',
    });
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      fetch.mock.calls[1][1].headers['Idempotency-Key'],
    );
  });
});
