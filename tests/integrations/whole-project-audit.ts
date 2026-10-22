if (process.env.NXOPA_ISOLATED_TEST_DATABASE !== '1')
  throw new Error(
    'Run pnpm test:full (or FULL_REGRESSION_SUITES=... pnpm test:full) to use an isolated test database',
  );
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, until } from './client.js';
import { db, lock } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { encrypt } from '../../apps/server/src/security.js';
import { recordRemoteRevocation } from '../../apps/server/src/registration-removal.js';
import { policySchema } from '../../packages/contracts/src/index.js';
import { pdfText } from './pdf-text.js';

if (config.production) throw new Error('Whole-project audit fixtures are development-only');
const run = randomUUID().slice(0, 8),
  contests: string[] = [],
  users: string[] = [];
const checks: string[] = [],
  failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    checks.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).stack}`);
    console.error(`FAIL ${name}: ${(error as Error).message}`);
  }
}
async function expectStatus(
  client: Client,
  path: string,
  method: string,
  body: unknown,
  expected: number,
) {
  const response = await client.raw(`/api/v1${path}`, method, body);
  assert.equal(response.status, expected, `${path}: ${await response.text()}`);
}
const token = (invitation: { url: string }) => new URL(invitation.url).pathname.split('/').at(-1)!;
await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
const admin = await new Client().login('admin');
const passwordHash = (await db.user.findUniqueOrThrow({ where: { username: 'alice' } }))
  .passwordHash;
async function actor(key: string, isCoach = false) {
  const user = await db.user.create({
    data: {
      username: `audit_${run}_${key}`,
      email: `audit-${run}-${key}@example.test`,
      name: `审计回归 ${key}`,
      passwordHash,
      verified: true,
      isCoach,
      profile: {
        student_id: `audit-${run}-${key}`,
        class_name: '回归一班',
        college: '测试学院',
        gender: '男',
      },
    },
  });
  users.push(user.id);
  return new Client().login(user.username);
}
async function contest(policy: Record<string, unknown> = {}, fields: unknown[] = []) {
  const c = await admin.api('/contests', 'POST', {
    title: `全项目审计 ${run} ${contests.length + 1}`,
    season: '审计回归',
    description: '隔离的虚构测试资料',
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED', ...policy }),
    fields,
  });
  contests.push(c.id);
  return c;
}
async function registration(owner: Client, c: { id: string }, submit = true) {
  const r = await owner.api('/registrations', 'POST', { contestId: c.id });
  return submit ? owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version }) : r;
}
async function grant(user: Client, contestId: string, permissions: string[]) {
  const previous = await db.adminGrant.findMany({
    where: { userId: user.user.id, contestId, level: 'CONTEST', revokedAt: null },
  });
  for (const grant of previous) await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
  return admin.api('/admin/grants', 'POST', {
    userId: user.user.id,
    level: 'CONTEST',
    contestId,
    permissions,
  });
}
async function paid(owner: Client) {
  const c = await contest({ feeMode: 'FIXED', feeCents: 10000 });
  const r = await registration(owner, c);
  const file = await owner.upload(r.id);
  const voucher = await owner.api(`/finance/${r.id}/vouchers`, 'POST', {
    amountCents: 10000,
    channel: 'Audit bank',
    payer: owner.user.name,
    paidAt: new Date().toISOString(),
    attachmentId: file.id,
  });
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  return { c, r: await owner.api(`/registrations/${r.id}`), file, voucher };
}
const invoice = {
  amountCents: 7000,
  title: '审计测试个人',
  email: 'audit@example.test',
  titleType: 'PERSON',
};
try {
  const owner = await actor('owner'),
    viewer = await actor('viewer'),
    coach = await actor('coach', true),
    issuer = await actor('issuer'),
    recipient = await actor('recipient');
  await check(
    'restarted TeX jobs discard auxiliary files owned by a previous compile UID',
    async () => {
      assert.ok(process.env.TEST_LATEX_CONTAINER, 'Run with the isolated full regression harness');
      const id = randomUUID(),
        folder = path.join(config.spool, id);
      await mkdir(path.join(folder, 'input'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(folder, 'input/document.aux'), '\\invalidOldAuxiliaryCommand');
      const exec = promisify(execFile);
      await exec('docker', [
        'exec',
        process.env.TEST_LATEX_CONTAINER!,
        'chown',
        '-R',
        '100999:100999',
        `/jobs/${id}/input`,
      ]);
      try {
        await writeFile(
          path.join(folder, 'request.json'),
          JSON.stringify({
            expiresAt: Date.now() + 120000,
            source: String.raw`\documentclass{article}\begin{document}RESTART-RECOVERED\end{document}`,
          }),
        );
        const result = await until(
          async () =>
            JSON.parse(await readFile(path.join(folder, 'result.json'), 'utf8').catch(() => '{}')),
          (result) => result.ok !== undefined,
          90000,
        );
        assert.equal(result.ok, true, result.error);
        assert.match(
          await pdfText(new Uint8Array(await readFile(path.join(folder, 'document.pdf')))),
          /RESTART-RECOVERED/,
        );
        const canary = `/tmp/nxopa-readable-${run}`;
        await exec('docker', [
          'exec',
          process.env.TEST_LATEX_CONTAINER!,
          'sh',
          '-c',
          `printf 'WORLD-READABLE-CANARY' > ${canary} && chmod 644 ${canary}`,
        ]);
        assert.equal(
          (
            await exec('docker', [
              'exec',
              '--user',
              '100999:100999',
              process.env.TEST_LATEX_CONTAINER!,
              'cat',
              canary,
            ])
          ).stdout,
          'WORLD-READABLE-CANARY',
        );
        await rm(folder, { recursive: true, force: true });
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(folder, 'request.json'),
          JSON.stringify({
            expiresAt: Date.now() + 120000,
            source: String.raw`\documentclass{article}\begin{document}\input{${canary}}\end{document}`,
          }),
        );
        const blocked = await until(
          async () =>
            JSON.parse(await readFile(path.join(folder, 'result.json'), 'utf8').catch(() => '{}')),
          (r) => r.ok !== undefined,
          90000,
        );
        assert.equal(
          blocked.ok,
          false,
          'TeX must deny readable absolute paths independently of Unix permissions',
        );
        await exec('docker', ['exec', process.env.TEST_LATEX_CONTAINER!, 'rm', '-f', canary]);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
  await check('removed coaches cannot redeem their own pre-removal invitations', async () => {
    const c = await contest({ coachMode: 'OPTIONAL', maxCoaches: 2 });
    let r = await registration(owner, c, false);
    const invitation = await owner.api(`/registrations/${r.id}/invites`, 'POST', {
      kind: 'COACH',
      targetEmail: coach.user.email,
    });
    await coach.api(`/invitations/${token(invitation)}/accept`, 'POST', {});
    const dormant = await coach.api(`/registrations/${r.id}/invites`, 'POST', {
      kind: 'COACH',
      targetEmail: coach.user.email,
    });
    r = await owner.api(`/registrations/${r.id}`);
    await owner.api(`/registrations/${r.id}/coaches/${r.coaches[0].id}`, 'DELETE', {
      version: r.version,
    });
    await expectStatus(coach, `/invitations/${token(dormant)}/accept`, 'POST', {}, 400);
    assert.equal((await owner.api(`/registrations/${r.id}`)).coaches.length, 0);
    assert.equal(
      (await db.invitation.findUniqueOrThrow({ where: { id: dormant.id } })).revoked,
      true,
    );
  });
  await check(
    'VIEW and registration-review grants retain totals but cannot read financial records or files',
    async () => {
      const { c, r, file } = await paid(owner);
      const view = await grant(viewer, c.id, ['REGISTRATIONS']);
      const detail = await viewer.api(`/registrations/${r.id}`);
      assert.equal(detail.netPaidCents, 10000);
      assert.equal(detail.canReadFinanceDetails, false);
      for (const key of ['vouchers', 'invoices', 'refunds', 'ledger']) {
        assert.deepEqual(detail[key], []);
        await expectStatus(viewer, `/registrations/${r.id}/finance/${key}`, 'GET', undefined, 403);
      }
      await expectStatus(viewer, `/finance/accounts/${r.id}`, 'GET', undefined, 403);
      await expectStatus(viewer, `/files/${file.id}`, 'GET', undefined, 403);
      await grant(viewer, c.id, ['FINANCE']);
      assert.equal((await viewer.api(`/finance/accounts/${r.id}`)).netPaidCents, 10000);
      assert.equal((await viewer.raw(`/api/v1/files/${file.id}`)).status, 200);
      assert.equal((await owner.api(`/registrations/${r.id}`)).canReadFinanceDetails, true);
      await admin.api(`/admin/grants/${view.id}`, 'DELETE');
    },
  );
  await check(
    'non-final finance decisions reject unvalidated files; issued files survive invoice voiding',
    async () => {
      const { r } = await paid(owner),
        foreign = await recipient.upload();
      const refund = await owner.api(`/finance/${r.id}/refunds`, 'POST', {
        amountCents: 1000,
        reason: '审计退款',
      });
      for (const decision of ['APPROVED', 'REJECTED'])
        await expectStatus(
          admin,
          `/finance/refunds/${refund.id}/review`,
          'POST',
          { decision, attachmentId: foreign.id },
          400,
        );
      await admin.api(`/finance/refunds/${refund.id}/review`, 'POST', {
        decision: 'REJECTED',
        reason: '回归拒绝原因',
      });
      const request = await owner.api(`/finance/${r.id}/invoices`, 'POST', invoice);
      await expectStatus(
        admin,
        `/finance/invoices/${request.id}/review`,
        'POST',
        { decision: 'REJECTED', reason: '回归', attachmentId: foreign.id },
        400,
      );
      const actual = await admin.upload();
      await admin.api(`/finance/invoices/${request.id}/review`, 'POST', {
        decision: 'ISSUED',
        attachmentId: actual.id,
      });
      await expectStatus(
        admin,
        `/finance/invoices/${request.id}/review`,
        'POST',
        { decision: 'VOID', attachmentId: foreign.id },
        400,
      );
      await admin.api(`/finance/invoices/${request.id}/review`, 'POST', { decision: 'VOID' });
      assert.equal(
        (await db.invoiceRequest.findUniqueOrThrow({ where: { id: request.id } })).attachmentId,
        actual.id,
      );
      assert.equal((await admin.raw(`/api/v1/files/${actual.id}`, 'DELETE')).status, 400);
      assert.equal((await recipient.raw(`/api/v1/files/${foreign.id}`, 'DELETE')).status, 200);
    },
  );
  for (const kind of ['invoices', 'refunds'])
    await check(`mixed-case UUIDs serialize concurrent ${kind} reservations`, async () => {
      const { r } = await paid(owner);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => (entered = resolve)),
        stop = new Promise<void>((resolve) => (release = resolve));
      const blocker = db.$transaction(
        async (tx) => {
          await lock(tx, r.id);
          entered();
          await stop;
        },
        { timeout: 30000 },
      );
      await ready;
      const body =
        kind === 'invoices' ? invoice : { amountCents: 7000, reason: '混合大小写并发回归' };
      const requests = [r.id, r.id.toUpperCase()].map((id) =>
        owner.raw(`/api/v1/finance/${id}/${kind}`, 'POST', body, randomUUID()),
      );
      try {
        await until(
          async () => {
            const [row] = await db.$queryRaw<
              { count: bigint }[]
            >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=(hashtext(${r.id})::bigint & 4294967295)::oid`;
            return Number(row!.count);
          },
          (count) => count >= 2,
          10000,
        );
      } finally {
        release();
        await blocker;
      }
      const responses = await Promise.all(requests);
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 400]);
      const reservations =
        kind === 'invoices'
          ? await db.invoiceRequest.findMany({ where: { registrationId: r.id } })
          : await db.refund.findMany({ where: { registrationId: r.id } });
      assert.equal(
        reservations.reduce((sum, row) => sum + row.amountCents, 0),
        7000,
      );
    });
  await check('payment reversal is idempotent across UUID case aliases', async () => {
    const { r } = await paid(owner);
    const payment = r.ledger.find((entry: any) => entry.kind === 'PAYMENT');
    await grant(viewer, r.contestId, ['FINANCE']);
    assert.equal(
      (
        await admin.raw(`/api/v1/finance/ledger/${payment.id}/reverse`, 'POST', {
          reason: '禁止自审',
        })
      ).status,
      403,
    );
    const first = await viewer.api(`/finance/ledger/${payment.id}/reverse`, 'POST', {
      reason: '回归冲正',
    });
    const again = await viewer.api(`/finance/ledger/${payment.id.toUpperCase()}/reverse`, 'POST', {
      reason: '重复冲正',
    });
    assert.equal(first.id, again.id);
    assert.equal((await owner.api(`/finance/accounts/${r.id}`)).netPaidCents, 0);
  });
  await check(
    'revoking or resigning SYSTEM authority permanently invalidates its pending invitations',
    async () => {
      await admin.api('/admin/grants', 'POST', { userId: issuer.user.id, level: 'SENIOR' });
      for (const resign of [false, true]) {
        const system = await admin.api('/admin/grants', 'POST', {
          userId: issuer.user.id,
          level: 'SYSTEM',
        });
        const invitation = await issuer.api('/admin/invitations', 'POST', {
          kind: 'SYSTEM_ADMIN',
          userId: recipient.user.id,
        });
        if (resign) await issuer.api(`/auth/grants/${system.id}`, 'DELETE');
        else await admin.api(`/admin/grants/${system.id}`, 'DELETE');
        const replacement = await admin.api('/admin/grants', 'POST', {
          userId: issuer.user.id,
          level: 'SYSTEM',
        });
        await expectStatus(recipient, `/invitations/${token(invitation)}/accept`, 'POST', {}, 400);
        await admin.api(`/admin/grants/${replacement.id}`, 'DELETE');
      }
    },
  );
  for (const upperAnswer of [false, true])
    await check(
      `required file deletion invalidates case-alias references (${upperAnswer ? 'uppercase answer' : 'uppercase route'})`,
      async () => {
        const c = await contest({}, [
          { key: 'proof', label: '必需材料', scope: 'REGISTRATION', type: 'file', required: true },
        ]);
        let r = await registration(owner, c, false);
        const file = await owner.upload(r.id);
        r = await owner.api(`/registrations/${r.id}`, 'PUT', {
          ...r,
          answers: { registration: { proof: upperAnswer ? file.id.toUpperCase() : file.id } },
        });
        r = await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
        assert.equal(r.eligible, true);
        const template = await db.admissionTemplate.findFirstOrThrow({ where: { active: true } });
        const doc = await db.admissionDocument.create({
          data: {
            registrationId: r.id,
            registrationVersion: r.version,
            number: `AUDIT-${randomUUID()}`,
            templateId: template.id,
            templateVersion: template.version,
            location: '审计考点',
            state: 'RELEASED',
            releasedAt: new Date(),
          },
        });
        await owner.api(`/files/${upperAnswer ? file.id : file.id.toUpperCase()}`, 'DELETE');
        const changed = await owner.api(`/registrations/${r.id}`);
        assert.equal(changed.status, 'CORRECTION');
        assert.equal(changed.eligible, false);
        assert.ok(changed.version > r.version);
        assert.equal(
          (await db.admissionDocument.findUniqueOrThrow({ where: { id: doc.id } })).state,
          'STALE',
        );
      },
    );
  await check(
    'submitted personal photos are readable by reviewers and usable for real admission PDFs',
    async () => {
      const c = await contest({}, [
        { key: 'portrait', label: '照片', scope: 'PERSON', type: 'photo', required: true },
      ]);
      let r = await registration(owner, c, false);
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(await readFile('tests/fixtures/portrait.png'))], {
          type: 'image/png',
        }),
        'portrait.png',
      );
      const photo = await owner.api('/files?purpose=PERSONAL', 'POST', form);
      r.people[0].answers.portrait = photo.id;
      r = await owner.api(`/registrations/${r.id}`, 'PUT', r);
      r = await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
      await grant(viewer, c.id, ['REGISTRATIONS']);
      assert.equal((await viewer.raw(`/api/v1/files/${photo.id}`)).status, 200);
      await admin.api('/admissions/templates', 'POST', {
        contestId: c.id,
        name: '个人照片回归',
        source: String.raw`\documentclass{article}\usepackage{graphicx}\begin{document}PERSONAL-PHOTO {{admission.number}}\includegraphics[width=1cm]{ {{participant.assets.portrait}} }\end{document}`,
      });
      const generated = await admin.api('/admissions/generate', 'POST', {
        registrationIds: [r.id],
        room: 'A',
        seat: '1',
      });
      const documentId = generated.results[0].documentId;
      assert.ok(documentId, JSON.stringify(generated));
      const ready = await until(
        () => db.admissionDocument.findUniqueOrThrow({ where: { id: documentId } }),
        (doc) => ['READY', 'FAILED'].includes(doc.state),
        90000,
      );
      assert.equal(ready.state, 'READY');
      await admin.api(`/admissions/${documentId}/release`, 'POST');
      const response = await owner.raw(`/api/v1/admissions/${documentId}/download`);
      assert.equal(response.status, 200);
      assert.ok(
        (await pdfText(new Uint8Array(await response.arrayBuffer()))).includes(ready.number),
      );
    },
  );
  await check(
    'platform export requires the current activity permission and never contacts a platform',
    async () => {
      const c = await contest(),
        r = await registration(owner, c);
      await db.registration.update({
        where: { id: r.id },
        data: {
          organization: { name: '审计大学', shortName: 'AUDIT', country: 'CHN', icpcId: '' },
        },
      });
      const route = `/contests/${c.id}/platform-exports`;
      await expectStatus(viewer, route, 'POST', { platform: 'HYDRO' }, 403);
      await grant(viewer, c.id, ['INTEGRATIONS']);
      const result = await viewer.raw(`/api/v1${route}`, 'POST', { platform: 'HYDRO' });
      assert.equal(result.status, 201);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      await result.arrayBuffer();
      assert.equal(await db.platformExportAccount.count({ where: { registrationId: r.id } }), 1);
      await expectStatus(admin, '/integrations/instances', 'POST', {}, 404);
    },
  );
  await check(
    'eligibility loss records manual remote revocation even if the mapping was already stale',
    async () => {
      const c = await contest(),
        r = await registration(owner, c);
      const instance = await db.platformInstance.create({
        data: {
          name: '资格撤回回归',
          type: 'HYDRO',
          baseUrl: 'http://127.0.0.1:9',
          credentials: encrypt(JSON.stringify({ token: 'a'.repeat(32) })),
          allowedContestIds: [c.id],
        },
      });
      const binding = await db.platformBinding.create({
        data: {
          contestId: c.id,
          instanceId: instance.id,
          remoteContestId: 'eligibility',
          automatic: false,
        },
      });
      const mapping = await db.accountMapping.create({
        data: {
          registrationId: r.id,
          bindingId: binding.id,
          username: `eligibility-${run}`,
          credential: encrypt('fixture'),
          state: 'STALE',
          remoteUserId: 'eligibility-user',
        },
      });
      await owner.api(`/registrations/${r.id}`, 'PUT', { ...r, teamName: '待补正' });
      await until(
        () => db.remoteRevocation.count({ where: { registrationId: r.id, state: 'PENDING' } }),
        (count) => count > 0,
      );
      assert.equal(
        (await db.accountMapping.findUniqueOrThrow({ where: { id: mapping.id } })).state,
        'REVOKED_LOCALLY',
      );
      await db.platformInstance.update({ where: { id: instance.id }, data: { enabled: false } });
    },
  );
} finally {
  await db.contest.updateMany({
    where: { id: { in: contests } },
    data: { archived: true, published: false },
  });
  await db.adminGrant.updateMany({
    where: { userId: { in: users }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/whole-project-audit.json',
    JSON.stringify(
      { success: checks.length === 13 && failures.length === 0, checks, failures },
      null,
      2,
    ),
  );
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  await redis.quit();
  await db.$disconnect();
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`Whole-project audit: ${checks.length} cases passed`);

assert.equal(checks.length, 13, 'Every declared check must execute');
