import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { Client, until } from './client.js';
import { db, json, lock } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import {
  ensureCompetitionAccount,
  competitionCredentials,
} from '../../apps/server/src/competition-accounts.js';
import { defaultTemplate, policySchema } from '../../packages/contracts/src/index.js';
import { pdfText } from './pdf-text.js';
import { putBlob } from '../../apps/server/src/storage.js';

if (config.production || process.env.NXOPA_ISOLATED_TEST_DATABASE !== '1')
  throw new Error('Use the isolated full regression runner');
const stamp = randomUUID().slice(0, 8),
  contests: string[] = [],
  users: string[] = [],
  checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
const admin = await new Client().login('admin'),
  alice = await new Client().login('alice'),
  bob = await new Client().login('bob');
async function contest(extra: Record<string, unknown> = {}) {
  const c = await admin.api('/contests', 'POST', {
    title: `导出与准考证 ${stamp} ${contests.length}`,
    description: '隔离验收',
    season: '验收',
    opensAt: new Date(Date.now() - 60000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    startsAt: new Date(Date.now() + 172800000).toISOString(),
    published: true,
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
    fields: [],
    ...extra,
  });
  contests.push(c.id);
  return c;
}
async function entry(client: Client, c: any, changes: Record<string, unknown> = {}) {
  let r = await client.api('/registrations', 'POST', { contestId: c.id });
  if (Object.keys(changes).length)
    r = await client.api(`/registrations/${r.id}`, 'PUT', { ...r, ...changes });
  return client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
}
async function batch(c: any, action: string, scope: any, options = {}) {
  const preview = await admin.api(`/contests/${c.id}/admission-batches/preview`, 'POST', {
    action,
    scope,
    options,
  });
  const task = await admin.api(`/contests/${c.id}/admission-batches`, 'POST', {
    previewId: preview.previewId,
  });
  const result = await until(
    () => admin.api(`/jobs/${task.jobId}`),
    (j) => ['SUCCESS', 'FAILED'].includes(j.state),
    240000,
  );
  assert.equal(result.state, 'SUCCESS', result.error);
  return { preview, task, result: result.result };
}
try {
  for (const [route, method] of [
    ['/api/v1/admin/tokens', 'GET'],
    ['/api/v1/admin/webhooks', 'POST'],
    ['/api/v1/integrations/revocations', 'GET'],
    ['/api/automation/v1/contests', 'GET'],
    ['/api/integration/v1/contests', 'GET'],
  ])
    assert.equal(
      (await admin.raw(route!, method!, method === 'POST' ? {} : undefined)).status,
      404,
      route,
    );
  const c = await contest({
    accountSettings: { enabled: true, prefix: `${stamp}_`, showOnAdmission: true },
    fields: [
      { key: 'code', label: '长编号', scope: 'PERSON', type: 'text' },
      { key: 'note', label: '备注', scope: 'REGISTRATION', type: 'text' },
    ],
  });
  assert.equal(
    (await admin.raw(`/api/v1/contests/${c.id}/platform-exports`, 'POST', {})).status,
    404,
  );
  assert.equal(c.modules.integrations, undefined);
  pass('External platform, token, webhook and automation endpoints are absent');

  const passwordHash = (await db.user.findUniqueOrThrow({ where: { id: alice.user.id } }))
    .passwordHash;
  const newUser = await db.user.create({
    data: {
      username: `identity_${stamp}`,
      email: `identity_${stamp}@example.test`,
      name: '实名测试',
      verified: true,
      passwordHash,
      profile: {
        student_id: `identity-${stamp}`,
        class_name: '一班',
        college: '学院',
        gender: '男',
        school: '真实单位',
        enrollment_year: 2026,
      },
    },
  });
  users.push(newUser.id);
  const identityActor = await new Client().login(newUser.username);
  const gateContest = await contest();
  const draft = await identityActor.api('/registrations', 'POST', { contestId: gateContest.id });
  for (const status of ['UNSUBMITTED', 'PENDING', 'REJECTED']) {
    await db.user.update({ where: { id: newUser.id }, data: { identityStatus: status } });
    assert.equal(
      (
        await identityActor.raw(`/api/v1/registrations/${draft.id}/submit`, 'POST', {
          version: draft.version,
        })
      ).status,
      400,
    );
  }
  await db.user.update({ where: { id: newUser.id }, data: { identityStatus: 'UNSUBMITTED' } });
  for (const school of ['', null, 123, { name: '伪造对象' }, []]) {
    const missing = await identityActor.raw('/api/v1/auth/identity', 'POST', {
      kind: 'STUDENT',
      name: newUser.name,
      profile: { ...identityActor.user.profile, school },
      version: newUser.version,
    });
    assert.equal(missing.status, 400);
  }
  const malformedRequest = await db.identityRequest.create({
    data: {
      userId: newUser.id,
      data: json({
        kind: 'STUDENT',
        name: newUser.name,
        profile: { ...identityActor.user.profile, school: {} },
      }),
    },
  });
  assert.equal(
    (
      await admin.raw(`/api/v1/admin/identities/${malformedRequest.id}/review`, 'POST', {
        decision: 'APPROVED',
      })
    ).status,
    400,
  );
  await db.identityRequest.delete({ where: { id: malformedRequest.id } });
  await identityActor.ensureIdentity();
  const forged = await identityActor.api(`/registrations/${draft.id}`, 'PUT', {
    ...draft,
    organization: { name: '伪造单位' },
    teamEnglishName: 'updated',
  });
  const verified = await identityActor.api(`/registrations/${draft.id}/submit`, 'POST', {
    version: forged.version,
  });
  assert.equal(verified.organization.name, '真实单位');
  assert.equal(gateContest.accountSettings.enabled, false);
  assert.equal(await db.competitionAccount.count({ where: { contestId: gateContest.id } }), 0);
  const backfilled = await admin.api(`/contests/${gateContest.id}`, 'PUT', {
    ...gateContest,
    fields: [],
    accountSettings: { enabled: true, prefix: `later_${stamp}_`, showOnAdmission: true },
  });
  await until(
    () => db.competitionAccount.count({ where: { contestId: gateContest.id } }),
    (count) => count === 1,
  );
  const backfilledAccount = await competitionCredentials(verified.id);
  assert.equal(backfilledAccount?.username, `later_${stamp}_0001`);
  await admin.api(`/contests/${gateContest.id}`, 'PUT', {
    ...backfilled,
    fields: [],
    accountSettings: { ...backfilled.accountSettings, showOnAdmission: false },
  });
  assert.equal(await competitionCredentials(verified.id, true), null);
  assert.deepEqual(await competitionCredentials(verified.id), backfilledAccount);
  pass(
    'Identity gate rejects unverified states and missing institution, and ignores client-supplied organization',
  );

  let a = await alice.api('/registrations', 'POST', { contestId: c.id });
  a = await alice.api(`/registrations/${a.id}`, 'PUT', {
    ...a,
    organization: { name: '伪造单位' },
    answers: { registration: { note: '=1+1,"换行\n中文' } },
    people: a.people.map((p: any) => ({ ...p, answers: { code: '00012345678901234567890' } })),
  });
  a = await alice.api(`/registrations/${a.id}/submit`, 'POST', { version: a.version });
  const b = await entry(bob, c);
  assert.equal(a.organization.name, '示例大学');
  await Promise.all(
    Array.from({ length: 8 }, () =>
      db.$transaction(async (tx) => {
        await lock(tx, a.id);
        await ensureCompetitionAccount(tx, a.id);
      }),
    ),
  );
  assert.equal(await db.competitionAccount.count({ where: { registrationId: a.id } }), 1);
  const account = await db.competitionAccount.findUniqueOrThrow({
    where: { registrationId: a.id },
  });
  assert.equal(account.username, `${stamp}_0001`);
  assert.ok(
    !JSON.stringify(await alice.api(`/registrations/${a.id}`)).includes(account.credential),
  );
  const csvResponse = await admin.raw(
    `/api/v1/registrations/export?contestId=${c.id}&format=csv&includeCredentials=true`,
  );
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('cache-control') ?? '', /no-store/);
  const csv = await csvResponse.text();
  assert.ok(csv.includes('00012345678901234567890'));
  assert.ok(csv.includes("'=1+1"));
  assert.ok(csv.includes(account.username));
  const plain = await (
    await admin.raw(`/api/v1/registrations/export?contestId=${c.id}&format=csv`)
  ).text();
  assert.ok(!plain.includes('比赛密码'));
  const xlsxResponse = await admin.raw(
    `/api/v1/registrations/export?contestId=${c.id}&format=xlsx&includeCredentials=true`,
  );
  assert.match(xlsxResponse.headers.get('content-type') ?? '', /spreadsheetml/);
  const xlsx = Buffer.from(await xlsxResponse.arrayBuffer());
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx as any);
  const sheet = book.worksheets[0]!;
  const headers = sheet.getRow(1).values as string[];
  const column = (name: string) => headers.indexOf(name);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.views[0]?.state, 'frozen');
  assert.ok(sheet.autoFilter);
  const code = headers.findIndex((h) => String(h).includes('长编号'));
  assert.equal(sheet.getRow(2).getCell(code).value, '00012345678901234567890');
  assert.equal(sheet.getRow(2).getCell(column('比赛账号')).value, account.username);
  const note = headers.findIndex((h) => String(h).includes('备注'));
  assert.equal(sheet.getRow(2).getCell(note).value, '=1+1,"换行\n中文');
  const csvSheet = await new ExcelJS.Workbook().csv.read(Readable.from([csv]), {
    map: (value) => value,
  });
  assert.equal(csvSheet.rowCount, sheet.rowCount);
  for (let row = 1; row <= sheet.rowCount; row++)
    for (let cell = 1; cell <= sheet.columnCount; cell++) {
      const expected = String(sheet.getRow(row).getCell(cell).value ?? '');
      const actual = String(csvSheet.getRow(row).getCell(cell).value ?? '').replace(/^\uFEFF/, '');
      assert.ok(
        actual === expected || actual === `'${expected}`,
        `CSV / XLSX differ at ${row}:${cell}`,
      );
    }
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile('.runtime/reports/registration-export.xlsx', xlsx);
  pass(
    'CSV and real XLSX preserve Chinese, long text identifiers, formulas as text, and optional stable credentials',
  );

  const teamContest = await contest({
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 2,
      maxMembers: 3,
      coachMode: 'DISABLED',
      manualReview: false,
    }),
    accountSettings: { enabled: true, prefix: `team_${stamp}_`, showOnAdmission: true },
  });
  let team = await alice.api('/registrations', 'POST', { contestId: teamContest.id });
  team = await alice.api(`/registrations/${team.id}`, 'PUT', {
    ...team,
    teamName: '跨校团队',
    people: [
      ...team.people,
      { name: '另一单位成员', email: '', captain: false, answers: { school: '另一单位' } },
    ],
  });
  team = await alice.api(`/registrations/${team.id}/submit`, 'POST', { version: team.version });
  assert.equal(team.organization.name, '示例大学');
  assert.equal(await db.competitionAccount.count({ where: { registrationId: team.id } }), 1);
  const teamCsv = await (
    await admin.raw(
      `/api/v1/registrations/export?contestId=${teamContest.id}&format=csv&includeCredentials=true`,
    )
  ).text();
  const teamAccount = await db.competitionAccount.findUniqueOrThrow({
    where: { registrationId: team.id },
  });
  assert.equal(teamCsv.split(teamAccount.username).length - 1, 2);
  pass(
    'Cross-institution teams use the verified captain institution and share one credential across member export rows',
  );

  const removedContest = await contest({
    accountSettings: { enabled: true, prefix: `retained_${stamp}_`, showOnAdmission: true },
  });
  const removedEntry = await entry(alice, removedContest);
  await alice.api(`/registrations/${removedEntry.id}/cancel`, 'POST', {
    version: removedEntry.version,
  });
  assert.equal(await db.competitionAccount.count({ where: { contestId: removedContest.id } }), 0);
  const removedState = await admin.api(`/contests/${removedContest.id}`);
  assert.equal(
    removedState.accountPrefixLocked,
    true,
    'Prefix remains locked after the last account is deleted',
  );
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${removedContest.id}`, 'PUT', {
        ...removedState,
        accountSettings: { ...removedState.accountSettings, prefix: 'must_stay_locked_' },
      })
    ).status,
    400,
  );

  const frozen = await admin.api(`/contests/${c.id}`);
  assert.equal(frozen.accountPrefixLocked, true);
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${c.id}`, 'PUT', {
        ...frozen,
        accountSettings: { ...frozen.accountSettings, prefix: 'changed_' },
      })
    ).status,
    400,
  );
  await admin.api(`/contests/${c.id}`, 'PUT', {
    ...frozen,
    accountSettings: { ...frozen.accountSettings, enabled: false },
  });
  assert.ok(
    !(
      await (
        await admin.raw(`/api/v1/registrations/export?contestId=${c.id}&includeCredentials=true`)
      ).text()
    ).includes(account.username),
  );
  const disabled = await admin.api(`/contests/${c.id}`);
  await admin.api(`/contests/${c.id}`, 'PUT', {
    ...disabled,
    accountSettings: { ...disabled.accountSettings, enabled: true },
  });
  await until(
    () => db.competitionAccount.count({ where: { contestId: c.id } }),
    (n) => n === 2,
  );
  assert.equal(
    (await db.competitionAccount.findUniqueOrThrow({ where: { registrationId: a.id } })).credential,
    account.credential,
  );
  pass(
    'Prefix locks after first account; disabling hides credentials and reenabling preserves passwords',
  );
  const beforeReject = await admin.api(`/registrations/${b.id}`);
  const rejected = await admin.api(`/registrations/${b.id}/review`, 'POST', {
    version: beforeReject.version,
    decision: 'REJECTED',
    reason: '资格变化验收',
  });
  assert.equal(rejected.eligible, false);
  const held = await db.competitionAccount.findUniqueOrThrow({ where: { registrationId: b.id } });
  assert.ok(
    !(
      await (
        await admin.raw(
          `/api/v1/registrations/export?contestId=${c.id}&includeCredentials=true&review=REJECTED`,
        )
      ).text()
    ).includes(held.username),
  );
  await admin.api(`/registrations/${b.id}/review`, 'POST', {
    version: rejected.version,
    decision: 'APPROVED',
    reason: '恢复资格',
  });
  assert.equal(
    (await db.competitionAccount.findUniqueOrThrow({ where: { registrationId: b.id } })).credential,
    held.credential,
  );
  pass(
    'Loss of eligibility hides credentials and restoration reuses the same account and password',
  );

  const draftIds: string[] = [];
  for (let i = 0; i < 23; i++) {
    const r = await db.registration.create({
      data: {
        contestId: c.id,
        ownerId: alice.user.id,
        formVersion: 1,
        people: {
          create: { contestId: c.id, name: `草稿${i}`, email: '', captain: true, confirmed: true },
        },
      },
    });
    draftIds.push(r.id);
  }
  const current = await admin.api(`/contests/${c.id}`);
  const generated = await batch(
    current,
    'GENERATE',
    { mode: 'FILTERED', filters: {} },
    { room: 'A101', seat: '1' },
  );
  assert.equal(generated.preview.total, 25);
  assert.equal(generated.preview.processable, 2);
  assert.equal(generated.result.success, 2);
  assert.equal(generated.result.skipped, 23);
  const detail = await admin.api(`/registrations/${a.id}`),
    doc = detail.admissions.find((d: any) => d.state === 'READY');
  assert.ok(doc);
  assert.equal((await alice.raw(`/api/v1/admissions/${doc.id}/download`)).status, 403);
  const pdf = Buffer.from(
    await (await admin.raw(`/api/v1/admissions/${doc.id}/download`)).arrayBuffer(),
  );
  const text = await pdfText(pdf);
  assert.ok(text.replace(/\s/g, '').includes(account.username));
  assert.ok(text.replace(/\s/g, '').includes((await competitionCredentials(a.id))!.password));
  await writeFile('.runtime/reports/account-admission.pdf', pdf);
  pass(
    'Filtered batch spans more than one page, skips drafts, creates PDFs with credentials, and keeps them private before release',
  );

  const released = await batch(current, 'RELEASE', {
    mode: 'SELECTED',
    registrationIds: [a.id, b.id],
  });
  assert.equal(released.result.success, 2);
  assert.equal((await alice.raw(`/api/v1/admissions/${doc.id}/download`)).status, 200);
  const notifications = await db.auditEvent.count({
    where: { action: 'ADMISSION_RELEASE', resourceId: { in: [a.id, b.id] } },
  });
  await batch(current, 'RELEASE', { mode: 'FILTERED', filters: { review: 'APPROVED' } });
  assert.equal(
    await db.auditEvent.count({
      where: { action: 'ADMISSION_RELEASE', resourceId: { in: [a.id, b.id] } },
    }),
    notifications,
  );
  await db.job.update({
    where: { id: released.task.jobId },
    data: {
      state: 'FAILED',
      attempts: 4,
      error: '模拟完成后进程重试',
      leaseToken: null,
      leaseUntil: null,
    },
  });
  await db.admissionBatch.update({
    where: { id: released.task.batchId },
    data: { state: 'FAILED' },
  });
  await admin.api(`/admin/jobs/${released.task.jobId}/retry`, 'POST', {});
  await until(
    () => admin.api(`/jobs/${released.task.jobId}`),
    (j) => j.state === 'SUCCESS',
  );
  assert.equal(
    await db.auditEvent.count({
      where: { action: 'ADMISSION_RELEASE', resourceId: { in: [a.id, b.id] } },
    }),
    notifications,
  );
  const downloaded = await batch(current, 'DOWNLOAD', {
    mode: 'SELECTED',
    registrationIds: [a.id, b.id],
  });
  assert.equal(downloaded.result.files.length, 1);
  const archive = await admin.raw(downloaded.result.files[0].downloadUrl);
  assert.equal(archive.status, 200);
  const zip = Buffer.from(await archive.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  assert.equal((await bob.raw(downloaded.result.files[0].downloadUrl)).status, 403);
  pass('Batch release opens authenticated downloads once, and ZIP access is permission checked');

  const preview = await admin.api(`/contests/${c.id}/admission-batches/preview`, 'POST', {
    action: 'RELEASE',
    scope: { mode: 'SELECTED', registrationIds: [a.id, b.id] },
  });
  await db.registration.update({ where: { id: a.id }, data: { version: { increment: 1 } } });
  const started = await admin.api(`/contests/${c.id}/admission-batches`, 'POST', {
    previewId: preview.previewId,
  });
  const changed = await until(
    () => admin.api(`/jobs/${started.jobId}`),
    (j) => j.state === 'SUCCESS',
  );
  assert.equal(changed.result.failed, 1);
  assert.equal(changed.result.success, 1);
  assert.equal((await admin.raw(downloaded.result.files[0].downloadUrl)).status, 400);
  pass(
    'Frozen versions detect changed registrations, retain partial successes, and invalidate old ZIP downloads',
  );

  const scopeGrant = await admin.api('/admin/grants', 'POST', {
    userId: bob.user.id,
    level: 'CONTEST',
    contestId: c.id,
    permissions: ['VIEW'],
  });
  assert.equal(
    (
      await bob.raw(
        `/api/v1/registrations/export?contestId=${c.id}&format=xlsx&includeCredentials=true`,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await bob.raw(`/api/v1/contests/${c.id}/admission-batches/preview`, 'POST', {
        action: 'RELEASE',
        scope: { mode: 'FILTERED', filters: {} },
      })
    ).status,
    403,
  );
  await admin.api(`/admin/grants/${scopeGrant.id}`, 'DELETE');
  pass('Scoped permissions independently protect exports and admission batch execution');

  // Exercise the real 1000-document ZIP boundary without recompiling 1001 identical PDFs.
  const large = await contest();
  const template = await db.admissionTemplate.findFirstOrThrow({
    where: { contestId: null, active: true },
    orderBy: { version: 'desc' },
  });
  const original = await db.admissionDocument.findUniqueOrThrow({ where: { id: doc.id } });
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    id: randomUUID(),
    contestId: large.id,
    ownerId: alice.user.id,
    number: i + 1,
    formVersion: 1,
    status: 'SUBMITTED',
    review: 'APPROVED',
    eligible: true,
    version: 1,
  }));
  await db.registration.createMany({ data: rows });
  await db.admissionDocument.createMany({
    data: rows.map((r, i) => ({
      id: randomUUID(),
      registrationId: r.id,
      number: `BATCH-${stamp}-${i}`,
      registrationVersion: 1,
      templateId: template.id,
      templateVersion: template.version,
      state: 'READY',
      location: '',
      storageKey: original.storageKey,
      storageBackend: original.storageBackend,
      storageConfigId: original.storageConfigId,
      sha256: original.sha256,
    })),
  });
  const split = await batch(large, 'DOWNLOAD', { mode: 'FILTERED', filters: {} });
  assert.equal(split.result.files.length, 2);
  assert.equal(split.result.success, 1001);
  for (const file of split.result.files)
    assert.equal((await admin.raw(file.downloadUrl)).status, 200);
  const largePdf = await putBlob(
    `zip-capacity-${stamp}`,
    Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(26 * 1024 * 1024)]),
    'application/pdf',
  );
  await db.admissionDocument.updateMany({
    where: { registrationId: { in: rows.slice(0, 4).map((r) => r.id) } },
    data: largePdf,
  });
  const sized = await batch(large, 'DOWNLOAD', {
    mode: 'SELECTED',
    registrationIds: rows.slice(0, 4).map((r) => r.id),
  });
  assert.equal(sized.result.files.length, 2);
  assert.ok(sized.result.files[0].size > 50 * 1024 * 1024);
  for (const file of sized.result.files) {
    const response = await admin.raw(file.downloadUrl);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, file.size);
  }
  pass(
    'ZIP archives split at 1000 documents and 100 MiB; parts larger than 50 MiB remain downloadable',
  );
} finally {
  await db.contest.updateMany({ where: { id: { in: contests } }, data: { archived: true } });
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/registration-exports.json',
    JSON.stringify({ success: checks.length === 11, checks }, null, 2),
  );
  await redis.quit();
  await db.$disconnect();
}
assert.equal(checks.length, 11);
