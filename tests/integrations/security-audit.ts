import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, base, until } from './client.js';
import { encrypt } from '../../apps/server/src/security.js';
import { db, json } from '../../apps/server/src/db.js';
import { redis, session } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema, type ContestPolicy } from '../../packages/contracts/src/index.js';

if (config.production) throw new Error('Security fixtures are development-only');
const run = randomUUID().slice(0, 8);
const contests: string[] = [],
  grants: string[] = [];
const results: { name: string; status: string; error?: string }[] = [];
const selected = process.argv.slice(2);
async function check(name: string, test: () => Promise<void>) {
  if (selected.length && !selected.includes(name)) return;
  try {
    await test();
    results.push({ name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ name, status: 'FAIL', error });
    console.error(`FAIL ${name}: ${error}`);
  }
}
try {
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
  const admin = await new Client().login('admin');
  const alice = await new Client().login('alice');
  const bob = await new Client().login('bob');
  async function contest(extra: Record<string, unknown> = {}, fields: unknown[] = []) {
    const c = await admin.api('/contests', 'POST', {
      title: `安全回归 ${run} ${contests.length}`,
      season: '安全验收',
      description: '独立测试活动',
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      policy: { ...policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }), ...extra },
      fields,
    });
    contests.push(c.id);
    return c;
  }
  async function grant(client: Client, contestId: string, permissions: string[]) {
    const row = await db.adminGrant.create({
      data: {
        userId: client.user.id,
        level: 'CONTEST',
        contestId,
        permissions,
        grantedBy: admin.user.id,
      },
    });
    grants.push(row.id);
  }
  async function entry(c: any, client = alice, answers?: Record<string, unknown>) {
    let r = await client.api('/registrations', 'POST', { contestId: c.id });
    if (answers)
      r = await client.api(`/registrations/${r.id}`, 'PUT', {
        ...r,
        people: r.people.map((p: any) => ({ ...p, answers })),
      });
    return client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  }
  async function paid(c: any, amountCents = 100) {
    const r = await entry(c);
    const file = await alice.upload(r.id);
    const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
      amountCents,
      channel: '安全回归',
      reference: randomUUID(),
      payer: '测试用户',
      paidAt: new Date().toISOString(),
      attachmentId: file.id,
    });
    return { r, file, voucher };
  }
  await check('preauth-cross-site-request', async () => {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.invalid',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ account: 'alice', password: 'DemoContest2026!' }),
    });
    assert.equal(response.status, 403, 'Cross-site pre-authentication POST must be rejected');
    assert.equal(response.headers.getSetCookie().length, 0);
  });
  await check('voucher-declared-amount-is-immutable', async () => {
    const { r, voucher } = await paid(await contest({ feeMode: 'FIXED', feeCents: 100 }));
    const response = await admin.raw(`/api/v1/finance/vouchers/${voucher.id}/review`, 'POST', {
      decision: 'CONFIRMED',
      amountCents: 100000000,
    });
    assert.equal(response.status, 400);
    assert.equal((await alice.api(`/finance/accounts/${r.id}`)).netPaidCents, 0);
  });
  await check('transaction-reference-required-and-unique', async () => {
    const c = await contest({ feeMode: 'FIXED', feeCents: 100 });
    const r = await entry(c);
    const file = await alice.upload(r.id);
    const payload = {
      amountCents: 100,
      channel: 'audit-bank',
      payer: '测试用户',
      paidAt: new Date().toISOString(),
      attachmentId: file.id,
    };
    const v = await (await alice.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', payload)).json();
    assert.equal(
      (
        await admin.raw(`/api/v1/finance/vouchers/${v.id}/review`, 'POST', {
          decision: 'CONFIRMED',
        })
      ).status,
      400,
    );
    const reference = randomUUID();
    await admin.api(`/finance/vouchers/${v.id}/review`, 'POST', {
      decision: 'CONFIRMED',
      reference,
    });
    const other = await alice.upload(r.id);
    const duplicate = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
      ...payload,
      attachmentId: other.id,
      reference,
    });
    assert.equal(
      (
        await admin.raw(`/api/v1/finance/vouchers/${duplicate.id}/review`, 'POST', {
          decision: 'CONFIRMED',
        })
      ).status,
      409,
    );
    assert.equal((await alice.api(`/finance/accounts/${r.id}`)).netPaidCents, 100);
    assert.equal(
      (await db.paymentVoucher.findUniqueOrThrow({ where: { id: duplicate.id } })).status,
      'PENDING',
    );
  });
  await check('finance-manager-cannot-confirm-own-receipt', async () => {
    const c = await contest({ feeMode: 'FIXED', feeCents: 100 });
    const { voucher } = await paid(c);
    await grant(alice, c.id, ['VIEW', 'FINANCE']);
    assert.equal(
      (
        await alice.raw(`/api/v1/finance/vouchers/${voucher.id}/review`, 'POST', {
          decision: 'CONFIRMED',
        })
      ).status,
      403,
    );
  });
  await check('duplicate-voucher-attachment', async () => {
    const { r, file } = await paid(await contest({ feeMode: 'FIXED', feeCents: 100 }));
    const response = await alice.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', {
      amountCents: 100,
      channel: '安全回归',
      payer: '测试用户',
      paidAt: new Date().toISOString(),
      attachmentId: file.id,
    });
    assert.equal(response.status, 409, 'One attachment must not create a second payable voucher');
  });
  await check('excess-refund-requires-independent-completion', async () => {
    const c = await contest({ feeMode: 'FIXED', feeCents: 100 });
    const { r, voucher } = await paid(c, 200);
    await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
    const refund = await alice.api(`/finance/${r.id}/refunds`, 'POST', {
      amountCents: 200,
      reason: '退回多付费用',
    });
    await admin.api(`/finance/refunds/${refund.id}/review`, 'POST', { decision: 'APPROVED' });
    assert.equal(
      (
        await admin.raw(`/api/v1/finance/refunds/${refund.id}/review`, 'POST', {
          decision: 'COMPLETED',
          reference: randomUUID(),
        })
      ).status,
      403,
    );
    await grant(bob, c.id, ['VIEW', 'FINANCE']);
    await bob.api(`/finance/refunds/${refund.id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: randomUUID(),
    });
    assert.equal((await alice.api(`/finance/accounts/${r.id}`)).netPaidCents, 0);
  });
  await check('administrator-cannot-replace-login-email', async () => {
    const source = await db.user.findUniqueOrThrow({ where: { id: bob.user.id } });
    const isolated = await db.user.create({
      data: {
        username: `audit_${run}`,
        email: `audit-${run}@example.test`,
        name: source.name,
        profile: json(source.profile),
        passwordHash: source.passwordHash,
        verified: true,
      },
    });
    const target = await admin.api(`/admin/users/${isolated.id}`);
    const profile = target.user ?? target;
    try {
      const response = await admin.raw(`/api/v1/admin/users/${isolated.id}`, 'PUT', {
        version: profile.version,
        name: profile.name,
        username: profile.username,
        email: `attacker-${run}@example.test`,
        profile: profile.profile,
        tags: profile.tags ?? [],
      });
      assert.equal(response.status, 403);
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: isolated.id } })).email,
        profile.email,
      );
    } finally {
      await db.user.delete({ where: { id: isolated.id } });
    }
  });
  await check('unique-participant-fields', async () => {
    const c = await contest({ uniquePersonFields: ['audit_id'] }, [
      { key: 'audit_id', label: '学号', type: 'text', scope: 'PERSON', required: true },
    ]);
    await entry(c, alice, { audit_id: 'SAME-STUDENT' });
    let r = await bob.api('/registrations', 'POST', { contestId: c.id });
    r = await bob.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      people: r.people.map((p: any) => ({ ...p, answers: { audit_id: 'same-student' } })),
    });
    const response = await bob.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', {
      version: r.version,
    });
    assert.ok(
      [400, 409].includes(response.status),
      `Duplicate identity accepted: ${response.status}`,
    );
  });
  await check('concurrent-registration-capacity', async () => {
    const c = await contest({ capacity: 1 });
    const a = await alice.api('/registrations', 'POST', { contestId: c.id });
    const b = await bob.api('/registrations', 'POST', { contestId: c.id });
    const responses = await Promise.all(
      [
        [alice, a],
        [bob, b],
      ].map(([client, r]: any) =>
        client.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', { version: r.version }),
      ),
    );
    assert.deepEqual(responses.map((r: Response) => r.status).sort(), [201, 400]);
    assert.equal(
      await db.registration.count({ where: { contestId: c.id, status: 'SUBMITTED' } }),
      1,
    );
  });
  await check('reserved-capacity-survives-correction', async () => {
    const c = await contest({ capacity: 2, manualReview: true });
    const a = await entry(c);
    await entry(c, bob);
    await admin.api(`/contests/${c.id}`, 'PUT', {
      ...c,
      fields: [],
      policy: { ...c.policy, capacity: 1 },
    });
    const correction = await admin.api(`/registrations/${a.id}/review`, 'POST', {
      version: a.version,
      decision: 'CORRECTION',
      reason: '补正测试',
    });
    await alice.api(`/registrations/${a.id}/submit`, 'POST', { version: correction.version });
  });
  await check('deletion-retains-redacted-audit-and-separates-cancellations', async () => {
    const c = await contest({ manualReview: true });
    let r = await entry(c);
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
    await db.auditEvent.create({
      data: {
        actorId: alice.user.id,
        action: 'REGISTRATION_EDIT',
        resourceId: r.id,
        details: { name: 'AUDIT_PRIVATE_PAYLOAD', answers: { private: 'AUDIT_PRIVATE_PAYLOAD' } },
      },
    });
    await admin.api(`/registrations/${r.id}`, 'DELETE', {
      version: r.version,
      reason: '管理员删除测试',
    });
    const events = await db.auditEvent.findMany({ where: { resourceId: r.id } });
    assert.ok(events.some((e) => e.action === 'REVIEW'));
    assert.ok(events.some((e) => e.action === 'REGISTRATION_EDIT'));
    assert.ok(!JSON.stringify(events).includes('AUDIT_PRIVATE_PAYLOAD'));
    const before = await db.contest.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(before.deletedSubmittedCount, 1);
    assert.equal(before.deletedCancelledCount, 0);
    const next = await entry(c);
    await alice.api(`/registrations/${next.id}/cancel`, 'POST', { version: next.version });
    const after = await db.contest.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(after.deletedSubmittedCount, 2);
    assert.equal(after.deletedCancelledCount, 1);
  });
  await check('export-permission-and-field-columns', async () => {
    const c = await contest({}, [
      { key: 'student_no', label: '学号', type: 'text', scope: 'PERSON' },
      { key: 'remarks', label: '备注', type: 'text', scope: 'REGISTRATION' },
    ]);
    await entry(c, alice, { student_no: '=FORMULA' });
    await grant(bob, c.id, ['VIEW']);
    assert.equal((await bob.raw(`/api/v1/registrations/export?contestId=${c.id}`)).status, 403);
    const text = await (await admin.raw(`/api/v1/registrations/export?contestId=${c.id}`)).text();
    assert.ok(text.includes('学号') && text.includes('备注'));
    assert.ok(!text.includes('自定义字段'));
    assert.ok(text.includes("'=FORMULA"));
    assert.ok(text.includes('应收(元)'));
    assert.ok(
      await db.auditEvent.count({ where: { action: 'REGISTRATION_EXPORT', resourceId: c.id } }),
    );
    await grant(bob, c.id, ['VIEW', 'REGISTRATIONS']);
    const withoutFinance = await (
      await bob.raw(`/api/v1/registrations/export?contestId=${c.id}`)
    ).text();
    assert.ok(withoutFinance.includes('学号'));
    assert.ok(!withoutFinance.includes('应收(元)'));
  });
  await check('deep-pagination-is-bounded', async () => {
    assert.equal((await alice.raw('/api/v1/registrations?page=1000000&pageSize=100')).status, 400);
  });
  await check('team-export-all-scopes-and-historical-fields', async () => {
    const fields = [
      { key: 'person_note', label: '成员备注', scope: 'PERSON', type: 'text' },
      { key: 'team_note', label: '队伍备注', scope: 'TEAM', type: 'text' },
      { key: 'entry_note', label: '报名备注', scope: 'REGISTRATION', type: 'text' },
      { key: 'coach_note', label: '老师备注', scope: 'COACH', type: 'text' },
    ];
    const c = await contest(
      {
        mode: 'TEAM',
        memberMode: 'MANUAL',
        minMembers: 2,
        maxMembers: 2,
        coachMode: 'OPTIONAL',
        feeMode: 'FIXED',
        feeCents: 12345,
      },
      fields,
    );
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const special = '备注含逗号,引号"及换行\n第二行';
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      teamName: `导出团队 ${run}`,
      answers: { team: { team_note: '队伍字段' }, registration: { entry_note: special } },
      people: [
        { ...r.people[0], answers: { ...r.people[0].answers, person_note: '队长字段' } },
        { name: '独立导出队员', email: '', captain: false, answers: { person_note: '队员字段' } },
      ],
    });
    const teacher = await db.user.findUniqueOrThrow({ where: { username: 'teacher' } });
    await db.registrationCoach.create({
      data: { registrationId: r.id, userId: teacher.id, answers: { coach_note: '指导老师字段' } },
    });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const current = await admin.api(`/contests/${c.id}`);
    await admin.api(`/contests/${c.id}`, 'PUT', {
      ...current,
      fields: fields.filter((f) => f.key !== 'person_note'),
    });
    const response = await admin.raw(`/api/v1/registrations/export?contestId=${c.id}`);
    assert.equal(response.status, 200);
    const csv = await response.text();
    const cells = [...csv.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n)/g)].map((match) =>
      match[1]!.replaceAll('""', '"'),
    );
    const header = cells.slice(
      0,
      csv.slice(0, csv.indexOf('\r\n')).match(/"(?:[^"]|"")*"/g)!.length,
    );
    assert.equal(cells.length, header.length * 3);
    const rows = [cells.slice(header.length, header.length * 2), cells.slice(header.length * 2)];
    const value = (row: string[], column: string) => {
      const index = header.indexOf(column);
      assert.ok(index >= 0, `Missing column ${column}`);
      return row[index];
    };
    assert.deepEqual(
      rows.map((row) => value(row, '成员·成员备注 (person_note)')),
      ['队长字段', '队员字段'],
    );
    for (const row of rows) {
      assert.equal(value(row, '队伍·队伍备注 (team_note)'), '队伍字段');
      assert.equal(value(row, '报名·报名备注 (entry_note)'), special);
      assert.equal(value(row, '老师1·老师备注 (coach_note)'), '指导老师字段');
      assert.equal(value(row, '老师1·邮箱'), teacher.email);
    }
    assert.equal(value(rows[0]!, '应收(元)'), '123.45');
    assert.equal(value(rows[1]!, '应收(元)'), '');
    // Two complete 25-registration batches plus the empty final cursor page.
    const additional = Array.from({ length: 49 }, (_, index) => ({
      id: randomUUID(),
      contestId: c.id,
      ownerId: alice.user.id,
      number: index + 2,
      status: 'SUBMITTED',
      review: 'APPROVED',
      formVersion: r.formVersion,
      submittedAt: new Date(),
      teamName: `导出分页 ${index}`,
    }));
    await db.registration.createMany({ data: additional });
    await db.registrationPerson.createMany({
      data: additional.map((item, index) => ({
        registrationId: item.id,
        contestId: c.id,
        name: `批次选手 ${index}`,
        captain: true,
        confirmed: true,
        answers: { person_note: `字段 ${index}` },
      })),
    });
    const completeCsv = await (
      await admin.raw(`/api/v1/registrations/export?contestId=${c.id}`)
    ).text();
    const completeCells = [...completeCsv.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n)/g)];
    assert.equal(completeCells.length, header.length * 52);
    for (let index = 0; index < additional.length; index++)
      assert.ok(completeCsv.includes(`"批次选手 ${index}"`));
  });
  await check('webhook-cannot-target-loopback', async () => {
    const c = await contest();
    const response = await admin.raw('/api/v1/admin/webhooks', 'POST', {
      contestId: c.id,
      url: 'http://127.0.0.1:3000/api/v1/health',
    });
    assert.equal(
      response.status,
      400,
      'Private platform integration settings must not permit private webhooks',
    );
    await grant(bob, c.id, ['VIEW', 'INTEGRATIONS']);
    assert.equal(
      (
        await bob.raw('/api/v1/admin/webhooks', 'POST', {
          contestId: c.id,
          url: 'http://127.0.0.1:3000',
          allowPrivate: true,
        })
      ).status,
      403,
    );
    const approved = await admin.api('/admin/webhooks', 'POST', {
      contestId: c.id,
      url: 'http://127.0.0.1:3000',
      allowPrivate: true,
    });
    assert.equal(
      (await db.webhook.findUniqueOrThrow({ where: { id: approved.id } })).privateApprovedBy,
      admin.user.id,
    );
    assert.equal(
      (
        await admin.raw('/api/v1/admin/webhooks', 'POST', {
          contestId: c.id,
          url: 'http://169.254.169.254',
          allowPrivate: true,
        })
      ).status,
      400,
    );
  });
  await check('secure-session-uses-public-https-without-proxy-header', async () => {
    const original = config.publicUrl;
    const agent = `security-cookie-${run}`;
    let secure: unknown;
    try {
      config.publicUrl = 'https://secure.example.test';
      await session(
        { secure: false, headers: { 'user-agent': agent } } as Parameters<typeof session>[0],
        {
          cookie: (_name: string, _value: string, options: any) => {
            secure = options.secure;
          },
        } as unknown as Parameters<typeof session>[1],
        bob.user.id,
      );
      assert.equal(secure, true);
    } finally {
      config.publicUrl = original;
      await db.session.deleteMany({ where: { userAgent: agent } });
    }
  });
  await check('invalid-reset-requests-are-rate-limited', async () => {
    const keys = ['rate:consume-RESET:127.0.0.1', 'rate:consume-RESET:::ffff:127.0.0.1'];
    await redis.del(...keys);
    try {
      const client = new Client();
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await client.raw('/api/v1/auth/reset', 'POST', {
              token: 'invalid-token-'.repeat(4),
              password: 'InvalidTokenPassword2026!',
            })
          ).status,
          400,
        );
      assert.equal(
        (
          await client.raw('/api/v1/auth/reset', 'POST', {
            token: 'invalid-token-'.repeat(4),
            password: 'InvalidTokenPassword2026!',
          })
        ).status,
        403,
      );
    } finally {
      await redis.del(...keys);
    }
  });
  await check('slow-platform-does-not-lock-registration-removal', async () => {
    let started = false,
      release!: () => void;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/probe'))
        return res.end(
          JSON.stringify({ capabilities: ['nickname', 'unofficial', 'contest_linkage'] }),
        );
      started = true;
      await proceed;
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          registrationId: request.envelope.registrationId,
          state: 'VERIFIED',
          remoteUserId: `late-user-${run}`,
          remoteTeamId: `late-team-${run}`,
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const c = await contest();
    const r = await entry(c);
    const instance = await db.platformInstance.create({
      data: {
        name: `slow-${run}`,
        type: 'HYDRO',
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        credentials: encrypt('{}'),
      },
    });
    const binding = await db.platformBinding.create({
      data: { contestId: c.id, instanceId: instance.id, remoteContestId: 'slow', automatic: false },
    });
    const mapping = await db.accountMapping.create({
      data: {
        registrationId: r.id,
        bindingId: binding.id,
        username: `slow-${run}`,
        credential: encrypt('isolated-test-password'),
      },
    });
    const job = await db.job.create({
      data: {
        kind: 'SYNC',
        resourceId: r.id,
        dedupeKey: `audit-sync:${run}`,
        payload: {
          mappingId: mapping.id,
          version: r.version,
          bindingVersion: binding.version,
          instanceVersion: instance.version,
          remoteTeamId: 'slow',
        },
      },
    });
    try {
      await until(async () => started, Boolean, 15000);
      const deletion = alice.raw(`/api/v1/registrations/${r.id}/cancel`, 'POST', {
        version: r.version,
      });
      const free = await Promise.race([
        deletion.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      release();
      assert.equal((await deletion).status, 201);
      assert.equal(free, true, 'Remote I/O must not hold the registration transaction lock');
      await until(
        () =>
          db.remoteRevocation.count({
            where: { registrationId: r.id, remoteUserId: `late-user-${run}`, state: 'PENDING' },
          }),
        (n) => n > 0,
        10000,
      );
      assert.equal(await db.accountMapping.count({ where: { registrationId: r.id } }), 0);
      assert.notEqual((await db.job.findUniqueOrThrow({ where: { id: job.id } })).state, 'SUCCESS');
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformInstance.update({ where: { id: instance.id }, data: { enabled: false } });
    }
  });
  await check('finance-history-rejects-prototype-key', async () => {
    const r = await entry(await contest());
    assert.equal(
      (await alice.raw(`/api/v1/registrations/${r.id}/finance/constructor`)).status,
      400,
    );
  });
  await check('invalid-file-id-is-validation-error', async () => {
    assert.equal((await admin.raw('/api/v1/files/not-a-uuid', 'DELETE')).status, 400);
  });
} finally {
  await db.adminGrant.deleteMany({ where: { id: { in: grants } } });
  await db.webhook.updateMany({ where: { contestId: { in: contests } }, data: { enabled: false } });
  await db.contest.updateMany({
    where: { id: { in: contests } },
    data: { published: false, archived: true },
  });
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/security-audit.json',
    JSON.stringify(
      { success: results.length > 0 && results.every((r) => r.status === 'PASS'), results },
      null,
      2,
    ),
  );
  await redis.quit();
  await db.$disconnect();
}
if (!results.length || results.some((r) => r.status !== 'PASS')) process.exitCode = 1;
