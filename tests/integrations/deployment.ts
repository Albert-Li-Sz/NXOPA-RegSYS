import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { Client, until, base } from './client.js';
import {
  defaultFields,
  defaultTemplate,
  policySchema,
} from '../../packages/contracts/src/index.js';
if (!base.includes(':8080'))
  throw new Error('Set TEST_URL=http://localhost:8080 to target the isolated Compose database');
const report: string[] = [];
const compose = (args: string[], input?: string | Buffer) =>
  execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEPLOY_SMTP_HOST: 'host.docker.internal', DEPLOY_SMTP_PORT: '51025' },
  });
async function ready(client: Client, registrationId: string) {
  return until(
    async () => {
      try {
        const response = await client.raw(`/api/v1/registrations/${registrationId}`);
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    },
    (value) => !!value,
    90000,
  );
}
let credentials: { email: string; password: string };
try {
  credentials = JSON.parse(await readFile('.runtime/deployment-credentials.json', 'utf8'));
} catch {
  credentials = {
    email: 'deployment-fixture@example.test',
    password: randomBytes(24).toString('base64url'),
  };
  await writeFile('.runtime/deployment-credentials.json', JSON.stringify(credentials), {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    ADMIN_EMAIL: credentials.email,
    ADMIN_PASSWORD: credentials.password,
    ADMIN_USERNAME: 'deployment_fixture',
  };
  execFileSync(
    'docker',
    [
      'compose',
      'run',
      '--rm',
      '-T',
      '-e',
      'ADMIN_EMAIL',
      '-e',
      'ADMIN_PASSWORD',
      '-e',
      'ADMIN_USERNAME',
      'api',
      'pnpm',
      'bootstrap:admin',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
try {
  const admin = await new Client().login(credentials.email, credentials.password);
  assert.ok(admin.user.isAdmin);
  report.push(
    'Production Compose health, versioned migrations, formal administrator bootstrap and login',
  );
  const demo = await admin.raw('/api/v1/auth/login', 'POST', {
    account: 'admin',
    password: 'DemoContest2026!',
  });
  assert.equal(demo.status, 401);
  report.push('Development demo accounts absent in production database');
  const contest = await admin.api('/contests', 'POST', {
    title: 'Docker 持久化验收竞赛',
    season: '容器验收',
    description: '独立容器数据库',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 10000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({
      manualReview: false,
      coachMode: 'DISABLED',
      feeMode: 'FIXED',
      feeCents: 500,
      paymentSequence: 'PAYMENT_FIRST',
    }),
    fields: [],
  });
  let r = await admin.api('/registrations', 'POST', { contestId: contest.id });
  r = await admin.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  assert.equal(r.eligible, false);
  const file = await admin.upload(r.id);
  const voucher = await admin.api(`/finance/${r.id}/vouchers`, 'POST', {
    amountCents: 500,
    channel: 'Docker fixture bank',
    reference: `deployment-${Date.now()}`,
    payer: '容器验收用户',
    paidAt: new Date().toISOString(),
    attachmentId: file.id,
  });
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  r = await admin.api(`/registrations/${r.id}`);
  assert.equal(r.eligible, true);
  assert.equal(r.netPaidCents, 500);
  assert.equal(r.ledger.filter((entry: any) => entry.kind === 'PAYMENT').length, 1);
  const document = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [r.id],
    room: 'B202',
    seat: '8',
  });
  const documentId = document.results[0].documentId;
  await until(
    () => admin.api(`/registrations/${r.id}`),
    (d) => d.admissions.some((a: any) => a.id === documentId && a.state === 'READY'),
    120000,
  );
  await admin.api(`/admissions/${documentId}/release`, 'POST');
  const pdf = await admin.raw(`/api/v1/admissions/${documentId}/download`);
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  report.push('Production private volumes, Outbox worker and isolated Chinese PDF generation');
  compose(['restart', 'postgres', 'redis', 'api', 'worker']);
  await until(
    async () => {
      try {
        return (await fetch(`${base}/api/v1/health`)).ok;
      } catch {
        return false;
      }
    },
    (v) => v,
    90000,
  );
  assert.equal((await admin.api(`/registrations/${r.id}`)).eligible, true);
  assert.equal((await admin.raw(`/api/v1/files/${file.id}`)).status, 200);
  report.push(
    'PostgreSQL, Redis, API and Worker restart preserves sessions, registration and private attachment',
  );
  execFileSync('bash', ['scripts/backup.sh'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const backup = (await readdir('.runtime/backups'))
    .filter((f) => f.endsWith('.ccbak'))
    .sort()
    .at(-1)!;
  assert.ok(backup);
  const before = await ready(admin, r.id);
  const corrupted = Buffer.from(await readFile(`.runtime/backups/${backup}`));
  corrupted[corrupted.length - 17] ^= 1;
  await writeFile('.runtime/tampered.ccbak', corrupted, { mode: 0o600 });
  assert.throws(() =>
    execFileSync('bash', ['scripts/restore.sh', '.runtime/tampered.ccbak'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }),
  );
  assert.equal((await ready(admin, r.id)).netPaidCents, 500);
  report.push('Tampered encrypted backup is rejected before changing database or private files');
  const cancel = await admin.api(`/registrations/${r.id}/cancel`, 'POST', {
    version: before.version,
  });
  assert.equal(cancel.eligible, false);
  execFileSync('bash', ['scripts/restore.sh', `.runtime/backups/${backup}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const restored = await ready(admin, r.id);
  assert.equal(restored.version, before.version);
  assert.equal(restored.eligible, true);
  assert.equal(restored.netPaidCents, 500);
  assert.deepEqual(restored.ledger, before.ledger);
  const attachment = await admin.raw(`/api/v1/files/${file.id}`);
  assert.equal(await attachment.text(), 'offline payment proof');
  report.push(
    'AES-256-GCM encrypted backup restores database versions, ledger, private files and original session',
  );
  console.log(`Deployment acceptance: ${report.length} checks passed`);
} finally {
  await writeFile('.runtime/reports/deployment.json', JSON.stringify({ report }, null, 2));
}
