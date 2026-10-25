import { afterEach, expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => new Map());
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(name, _options, callback) {
      handlers.set(name, callback);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
const previous = { url: process.env.CONTEST_CENTER_URL, token: process.env.CONTEST_CENTER_TOKEN };
afterEach(() => {
  vi.unstubAllGlobals();
  handlers.clear();
  for (const [key, value] of [
    ['CONTEST_CENTER_URL', previous.url],
    ['CONTEST_CENTER_TOKEN', previous.token],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
it('normalizes the base URL and preserves HTTP errors even when the response is not JSON', async () => {
  process.env.CONTEST_CENTER_URL = 'https://platform.example.test/';
  process.env.CONTEST_CENTER_TOKEN = 'fixture-token';
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await import('../../apps/mcp-adapter/src/main.ts');
  const error = await handlers.get('get_finance_summary')({
    contestId: '11111111-1111-4111-8111-111111111111',
  });
  expect(error.isError).toBe(true);
  expect(error.content[0].text).toContain('HTTP 502');
  expect(fetch.mock.calls[0][0]).toBe(
    'https://platform.example.test/api/automation/v1/finance?contestId=11111111-1111-4111-8111-111111111111',
  );
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  const empty = await handlers.get('list_contests')({});
  expect(empty.isError).toBe(false);
  expect(empty.content[0].text).toBe('null');
});
