import assert from 'node:assert/strict';
export const base = process.env.TEST_URL ?? 'http://localhost:3000';
export class Client {
  cookie = '';
  csrf = '';
  user: any;
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
    if (cookies.length) this.cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    return response;
  }
  async api(path: string, method = 'GET', body?: unknown, key?: string) {
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
        gender: '不便透露',
        school: '验收大学',
        phone: '00000000000',
      },
    });
    return this;
  }
  async upload(registrationId?: string) {
    const body = new FormData();
    body.append('file', new Blob(['offline payment proof'], { type: 'text/plain' }), 'receipt.txt');
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
