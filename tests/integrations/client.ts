import assert from 'node:assert/strict';
if (process.env.NODE_ENV === 'production')
  throw new Error('Acceptance fixtures must not run in production');
export const base = process.env.TEST_URL ?? 'http://localhost:3000';
export class Client {
  cookie = '';
  csrf = '';
  user: any;
  async register(body: Record<string, unknown>) {
    const { registrationProof } = await import('./registration-proof.js');
    const proof = await registrationProof(
      this,
      String(body.email),
      body.next as string | undefined,
    );
    const result = await this.api('/auth/register', 'POST', { ...body, ...proof });
    this.user = result.user;
    this.csrf = result.csrf;
    return result;
  }
  async raw(path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        'X-CSRF-Token': this.csrf,
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      const jar = new Map(
        this.cookie
          .split('; ')
          .filter(Boolean)
          .map((value) => {
            const split = value.indexOf('=');
            return [value.slice(0, split), value.slice(split + 1)];
          }),
      );
      for (const cookie of cookies) {
        const value = cookie.split(';')[0]!,
          split = value.indexOf('='),
          name = value.slice(0, split);
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(name);
        else jar.set(name, value.slice(split + 1));
      }
      this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    return response;
  }
  async api(path: string, method = 'GET', body?: unknown, key?: string) {
    // Successful financial fixtures use distinct real-world transaction references.
    // Missing-reference regression cases call raw() explicitly.
    if (
      method === 'POST' &&
      path.endsWith('/vouchers') &&
      body &&
      typeof body === 'object' &&
      !(body instanceof FormData) &&
      !('reference' in body)
    )
      body = {
        ...body,
        reference:
          'attachmentId' in body ? `TEST:${body.attachmentId}` : globalThis.crypto.randomUUID(),
      };
    if (
      method === 'POST' &&
      /^\/finance\/refunds\/[^/]+\/review$/.test(path) &&
      body &&
      typeof body === 'object' &&
      'decision' in body &&
      body.decision === 'REJECTED' &&
      !('reason' in body)
    )
      body = { ...body, reason: '测试拒绝原因' };
    const response = await this.raw(`/api/v1${path}`, method, body, key);
    const content = await response.text();
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${content.slice(0, 300)}`);
    assert.ok(content, `${method} ${path}: HTTP ${response.status} returned no JSON`);
    return JSON.parse(content) as any;
  }
  async login(account: string, password = 'DemoContest2026!') {
    await until(
      async () => {
        try {
          return (await fetch(`${base}/api/v1/health`)).ok;
        } catch {
          return false;
        }
      },
      (v) => v,
      15000,
    );
    const r = await this.api('/auth/login', 'POST', { account, password });
    this.user = r.user;
    this.csrf = r.csrf;
    return this;
  }
  async completeProfile() {
    this.user = await this.api('/auth/profile', 'PUT', {
      version: this.user.version,
      name: this.user.name,
      profile: {
        ...this.user.profile,
        student_id: `TEST-${this.user.id}`,
        class_name: '验收一班',
        college: '验收学院',
        gender: '男',
        school: '南京晓庄学院',
        phone: '00000000000',
      },
    });
    return this;
  }
  async upload(registrationId?: string) {
    const body = new FormData();
    body.append(
      'file',
      new Blob([`offline payment proof ${globalThis.crypto.randomUUID()}`], { type: 'text/plain' }),
      'receipt.txt',
    );
    return this.api(
      `/files${registrationId ? `?registrationId=${registrationId}` : ''}`,
      'POST',
      body,
    );
  }
}
export async function until<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('Timed out waiting for task');
}
