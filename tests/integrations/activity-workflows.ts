if (process.env.NXOPA_ISOLATED_TEST_DATABASE !== '1')
  throw new Error(
    'Run pnpm test:full (or FULL_REGRESSION_SUITES=... pnpm test:full) to use an isolated test database',
  );
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { db, lock } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { encrypt } from '../../apps/server/src/security.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema } from '../../packages/contracts/src/index.js';
import { migrateCancelledRegistrations } from '../../apps/server/src/registration-removal.js';
if (config.production) throw new Error('Development fixtures only');
const checks: string[] = [],
  run = Date.now();
function pass(s: string) {
  checks.push(s);
  console.log(`PASS ${s}`);
}
try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin'),
    alice = await new Client().login('alice'),
    bob = await new Client().login('bob'),
    teacher = await new Client().login('teacher'),
    carol = await new Client().login('carol');
  const create = (extra: Record<string, unknown> = {}) =>
    admin.api('/contests', 'POST', {
      title: `流程验收 ${run} ${checks.length}`,
      season: '验收',
      description: '独立流程数据',
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      policy: policySchema.parse({ manualReview: true, coachMode: 'DISABLED' }),
      fields: [],
      ...extra,
    });
  async function entry(c: any, client = alice) {
    let r = await client.api('/registrations', 'POST', { contestId: c.id });
    if (c.policy.mode === 'TEAM')
      r = await client.api(`/registrations/${r.id}`, 'PUT', {
        ...r,
        version: r.version,
        teamName: '流程验收队',
      });
    return client.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  }
  const c = await create();
  let r = await entry(c);
  assert.equal(
    (await alice.api(`/registrations/summary?role=mine&search=${encodeURIComponent(c.title)}`))
      .total,
    1,
  );
  assert.equal((await alice.raw(`/api/v1/registrations/${r.id}`)).status, 200);
  r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
    version: r.version,
    decision: 'APPROVED',
  });
  const receipt = await alice.api(
    `/registrations/${r.id}/cancel`,
    'POST',
    { version: r.version },
    randomUUID(),
  );
  assert.equal(receipt.deleted, true);
  assert.equal(receipt.financeAccountId, null);
  assert.equal((await alice.raw(`/api/v1/registrations/${r.id}`)).status, 404);
  assert.equal(await db.registrationRevision.count({ where: { registrationId: r.id } }), 0);
  assert.equal((await admin.api(`/contests/${c.id}/statistics`)).total, 0);
  assert.equal((await admin.api(`/overview?contestId=${c.id}`)).activities[0].cancelled, 1);
  assert.ok((await entry(c)).id !== r.id);
  pass('审核通过后永久取消、列表和统计更新、释放重新报名限制');
  const paid = await create({
    policy: policySchema.parse({
      feeMode: 'FIXED',
      feeCents: 5000,
      paymentSequence: 'PAYMENT_FIRST',
      coachMode: 'DISABLED',
    }),
  });
  let p = await entry(paid);
  p = await admin.api(`/registrations/${p.id}/review`, 'POST', {
    version: p.version,
    decision: 'CORRECTION',
    reason: '先修正资料',
  });
  assert.equal(p.status, 'CORRECTION');
  p = await alice.api(`/registrations/${p.id}/submit`, 'POST', { version: p.version });
  const file = await alice.upload(p.id);
  const voucherKey = randomUUID();
  const voucherBody = {
    amountCents: 5000,
    channel: 'test',
    payer: '验收付款人',
    paidAt: new Date().toISOString(),
    reference: `workflow-${run}`,
    attachmentId: file.id,
  };
  const voucher = await alice.api(`/finance/${p.id}/vouchers`, 'POST', voucherBody, voucherKey);
  await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
  p = await alice.api(`/registrations/${p.id}`);
  const invoice = await alice.api(`/finance/${p.id}/invoices`, 'POST', {
    title: '验收个人',
    titleType: 'PERSON',
    invoiceType: 'NORMAL',
    amountCents: 5000,
    email: 'workflow@example.test',
    taxId: '',
  });
  assert.equal(
    (await admin.raw(`/api/v1/registrations/${p.id}`, 'DELETE', { version: p.version, reason: '' }))
      .status,
    400,
  );
  const financialJob = await db.job.create({
    data: {
      resourceId: p.id,
      kind: 'MAIL',
      state: 'OUTBOX',
      dedupeKey: randomUUID(),
      payload: { finance: true, actionPath: `/finance/${p.id}` },
    },
  });
  const registrationJob = await db.job.create({
    data: {
      resourceId: p.id,
      kind: 'MAIL',
      state: 'OUTBOX',
      dedupeKey: randomUUID(),
      payload: { actionPath: `/registrations/${p.id}`, text: '旧报名资料' },
    },
  });
  const deleted = await admin.api(`/registrations/${p.id}`, 'DELETE', {
    version: p.version,
    reason: '管理员清理重复报名',
  });
  assert.equal(deleted.financeAccountId, p.id);
  assert.equal(
    (await db.job.findUniqueOrThrow({ where: { id: financialJob.id } })).state,
    'OUTBOX',
  );
  assert.equal(
    (await db.job.findUniqueOrThrow({ where: { id: registrationJob.id } })).state,
    'CANCELLED',
  );
  assert.deepEqual(
    (await db.job.findUniqueOrThrow({ where: { id: registrationJob.id } })).payload,
    {},
  );
  await db.job.delete({ where: { id: financialJob.id } });
  assert.equal((await bob.raw(`/api/v1/finance/accounts/${p.id}`)).status, 403);
  assert.equal((await alice.raw(`/api/v1/files/${file.id}`)).status, 200);
  const account = await alice.api(`/finance/accounts/${p.id}`);
  assert.equal(account.netPaidCents, 5000);
  assert.equal(account.invoices[0].id, invoice.id);
  assert.equal(
    (await alice.api(`/finance/${p.id}/vouchers`, 'POST', voucherBody, voucherKey)).id,
    voucher.id,
  );
  assert.equal(await db.paymentVoucher.count({ where: { registrationId: p.id } }), 1);
  await admin.api(`/finance/invoices/${invoice.id}/review`, 'POST', {
    decision: 'REJECTED',
    reason: '取消后退款',
  });
  const refund = await alice.api(`/finance/${p.id}/refunds`, 'POST', {
    amountCents: 5000,
    reason: '取消报名',
  });
  await admin.api(`/finance/refunds/${refund.id}/review`, 'POST', { decision: 'APPROVED' });
  await Promise.all([
    admin.api(`/finance/refunds/${refund.id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: `refund-${run}`,
    }),
    admin.api(`/finance/refunds/${refund.id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: `refund-${run}`,
    }),
  ]);
  assert.equal((await alice.api(`/finance/accounts/${p.id}`)).netPaidCents, 0);
  assert.equal(await db.ledgerEntry.count({ where: { registrationId: p.id, kind: 'REFUND' } }), 1);
  pass('未付款可补正，永久删除后独立财务、凭证授权和并发退款保持正确');
  const roomsContest = await create({
    modules: { admissions: true, rooms: true, integrations: false },
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
  });
  const a = await entry(roomsContest),
    b = await entry(roomsContest, bob);
  const room1 = await admin.api(`/contests/${roomsContest.id}/rooms`, 'POST', {
    name: 'A101',
    capacity: 1,
    location: '一号楼',
    sortOrder: 1,
  });
  const room2 = await admin.api(`/contests/${roomsContest.id}/rooms`, 'POST', {
    name: 'A102',
    capacity: 1,
    location: '一号楼',
    sortOrder: 2,
  });
  assert.equal((await bob.raw(`/api/v1/contests/${roomsContest.id}/rooms`)).status, 403);
  const preview = await admin.api(`/contests/${roomsContest.id}/seating/preview`, 'POST', {
    registrationIds: [a.id, b.id],
  });
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.assignments.length, 2);
  assert.equal(new Set(preview.assignments.map((x: any) => x.roomId)).size, 2);
  await admin.api(`/contests/${roomsContest.id}/seating/commit`, 'POST', {
    registrationIds: [a.id, b.id],
    ...preview,
  });
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${roomsContest.id}/seating/commit`, 'POST', {
        registrationIds: [a.id, b.id],
        ...preview,
      })
    ).status,
    409,
  );
  const x = await entry(roomsContest, carol);
  const insufficient = await admin.api(`/contests/${roomsContest.id}/seating/preview`, 'POST', {
    registrationIds: [x.id],
  });
  assert.ok(insufficient.errors.length);
  assert.equal(
    (
      await admin.raw(`/api/v1/contests/${roomsContest.id}/seating/commit`, 'POST', {
        registrationIds: [x.id],
        ...insufficient,
      })
    ).status,
    400,
  );
  assert.equal(await db.seatAssignment.count({ where: { registrationId: x.id } }), 0);
  await alice.api(`/registrations/${a.id}/cancel`, 'POST', { version: a.version });
  const reuse = await admin.api(`/contests/${roomsContest.id}/seating/preview`, 'POST', {
    registrationIds: [x.id],
  });
  assert.deepEqual(reuse.errors, []);
  const badImport = await admin.api(`/contests/${roomsContest.id}/seating/preview`, 'POST', {
    registrationIds: [x.id],
    assignments: [{ registrationId: x.id, roomId: room2.id, seat: 1 }],
  });
  assert.ok(badImport.errors.length);
  assert.ok(room1.id);
  pass('多考场容量、座位唯一、预览版本、跨角色隔离、删除释放座位');
  const teamContest = await create({
    policy: policySchema.parse({
      mode: 'TEAM',
      minMembers: 1,
      maxMembers: 3,
      coachMode: 'OPTIONAL',
      manualReview: false,
    }),
  });
  let team = await entry(teamContest);
  const invitation = await alice.api(`/registrations/${team.id}/invites`, 'POST', {
    kind: 'COACH',
  });
  await teacher.api(
    `/invitations/${new URL(invitation.url).pathname.split('/').pop()}/accept`,
    'POST',
    {},
  );
  team = await teacher.api(`/registrations/${team.id}`);
  assert.equal(
    (
      await teacher.raw(`/api/v1/registrations/${team.id}/cancel`, 'POST', {
        version: team.version,
      })
    ).status,
    403,
  );
  await db.registration.update({ where: { id: team.id }, data: { status: 'CANCEL_REQUESTED' } });
  await migrateCancelledRegistrations();
  assert.equal(await db.registration.count({ where: { id: team.id } }), 0);
  await migrateCancelledRegistrations();
  pass('指导老师不能永久取消，历史取消迁移可重复执行');
  const activity = await create({
    kind: 'ACTIVITY',
    modules: { admissions: false, rooms: false, integrations: false },
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
  });
  const act = await entry(activity);
  assert.equal(
    (await admin.raw('/api/v1/admissions/generate', 'POST', { registrationIds: [act.id] })).status,
    400,
  );
  assert.equal((await admin.raw(`/api/v1/contests/${activity.id}/rooms`)).status, 400);
  pass('通用活动关闭功能后，后端同步拒绝入口');
  const memberContest = await create({
    modules: { admissions: true, rooms: true, integrations: true },
    seatingMode: 'PERSON',
    policy: policySchema.parse({
      mode: 'TEAM',
      memberMode: 'MANUAL',
      minMembers: 2,
      maxMembers: 2,
      coachMode: 'DISABLED',
      manualReview: false,
    }),
  });
  let members = await alice.api('/registrations', 'POST', { contestId: memberContest.id });
  members = await alice.api(`/registrations/${members.id}`, 'PUT', {
    ...members,
    teamName: '同场双人队',
    people: [
      ...members.people,
      { name: '代填测试成员', email: 'member@example.test', captain: false, answers: {} },
    ],
  });
  members = await alice.api(`/registrations/${members.id}/submit`, 'POST', {
    version: members.version,
  });
  await admin.api(`/contests/${memberContest.id}/rooms`, 'POST', {
    name: '小考场',
    capacity: 1,
    sortOrder: 1,
  });
  let teamRoom = await admin.api(`/contests/${memberContest.id}/rooms`, 'POST', {
    name: '团队考场',
    location: '第二教学楼',
    capacity: 2,
    sortOrder: 2,
  });
  const memberPreview = await admin.api(`/contests/${memberContest.id}/seating/preview`, 'POST', {
    registrationIds: [members.id],
  });
  assert.deepEqual(memberPreview.errors, []);
  assert.equal(memberPreview.assignments.length, 2);
  assert.ok(memberPreview.assignments.every((a: any) => a.roomId === teamRoom.id));
  await admin.api(`/contests/${memberContest.id}/seating/commit`, 'POST', {
    registrationIds: [members.id],
    ...memberPreview,
  });
  const generated = await admin.api('/admissions/generate', 'POST', {
    registrationIds: [members.id],
  });
  const documentId = generated.results[0].documentId;
  const ticket = await until(
    () => alice.api(`/registrations/${members.id}`),
    (r) => r.admissions.some((a: any) => a.id === documentId && a.state === 'READY'),
    120000,
  );
  const document = ticket.admissions.find((d: any) => d.id === documentId);
  assert.match(document.seat, /代填测试成员/);
  assert.equal(document.room, '团队考场');
  await admin.api(`/admissions/${documentId}/release`, 'POST');
  const pdf = await alice.raw(`/api/v1/admissions/${documentId}/download`);
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  teamRoom = await admin.api(`/contests/${memberContest.id}/rooms/${teamRoom.id}`, 'PUT', {
    ...teamRoom,
    location: '新考点',
  });
  assert.equal((await alice.raw(`/api/v1/admissions/${documentId}/download`)).status, 403);
  assert.equal(
    (await db.admissionDocument.findUniqueOrThrow({ where: { id: documentId } })).state,
    'STALE',
  );
  pass('团队按成员同场排考、一队一张真实 PDF 汇总座位，考场变更使原准考证失效');
  const raceContest = await create({
    modules: { admissions: true, rooms: true, integrations: false },
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
  });
  const ra = await entry(raceContest),
    rb = await entry(raceContest, bob);
  await admin.api(`/contests/${raceContest.id}/rooms`, 'POST', { name: '唯一座位', capacity: 1 });
  const [pa, pb] = await Promise.all(
    [ra, rb].map((r) =>
      admin.api(`/contests/${raceContest.id}/seating/preview`, 'POST', { registrationIds: [r.id] }),
    ),
  );
  const commits = await Promise.all([
    admin.raw(`/api/v1/contests/${raceContest.id}/seating/commit`, 'POST', {
      registrationIds: [ra.id],
      ...pa,
    }),
    admin.raw(`/api/v1/contests/${raceContest.id}/seating/commit`, 'POST', {
      registrationIds: [rb.id],
      ...pb,
    }),
  ]);
  assert.deepEqual(commits.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    await db.seatAssignment.count({ where: { registration: { contestId: raceContest.id } } }),
    1,
  );
  pass('两人并发争抢最后座位，版本与数据库约束保证不超额');
  const idemContest = await create({
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
  });
  const createKey = randomUUID(),
    cancelKey = randomUUID();
  let original = await alice.api(
    '/registrations',
    'POST',
    { contestId: idemContest.id },
    createKey,
  );
  const privateFile = await alice.upload(original.id);
  original = await alice.api(`/registrations/${original.id}/submit`, 'POST', {
    version: original.version,
  });
  const instance = await db.platformInstance.create({
    data: {
      name: '清理待办测试',
      type: 'DOMJUDGE',
      baseUrl: 'https://fixture.invalid',
      credentials: encrypt('{}'),
    },
  });
  const binding = await db.platformBinding.create({
    data: {
      contestId: idemContest.id,
      instanceId: instance.id,
      remoteContestId: 'test',
      automatic: false,
    },
  });
  await db.accountMapping.create({
    data: {
      registrationId: original.id,
      bindingId: binding.id,
      username: 'fixture-user',
      credential: encrypt('fixture'),
      state: 'VERIFIED',
      remoteUserId: 'remote-user',
      remoteTeamId: 'remote-team',
    },
  });
  assert.equal(
    (await alice.raw(`/api/v1/integrations/registrations/${original.id}/credentials`)).status,
    404,
  );
  await alice.api(
    `/registrations/${original.id}/cancel`,
    'POST',
    { version: original.version },
    cancelKey,
  );
  const replay = await alice.api(
    '/registrations',
    'POST',
    { contestId: idemContest.id },
    createKey,
  );
  assert.equal(replay.deleted, true);
  assert.equal(replay.people, undefined);
  assert.equal(
    (
      await alice.api(
        `/registrations/${original.id}/cancel`,
        'POST',
        { version: original.version },
        cancelKey,
      )
    ).deleted,
    true,
  );
  assert.equal((await alice.raw(`/api/v1/files/${privateFile.id}`)).status, 404);
  assert.equal(await db.attachment.count({ where: { id: privateFile.id, deletedAt: null } }), 0);
  assert.equal(
    await db.remoteRevocation.count({ where: { registrationId: original.id, state: 'PENDING' } }),
    1,
  );
  assert.equal(
    (await bob.raw(`/api/v1/integrations/revocations?contestId=${idemContest.id}`)).status,
    403,
  );
  pass('永久删除清除专属附件、旧请求重放不返回报名资料，远端权限进入人工撤权待办');
  const moduleBinding = await db.platformBinding.create({
    data: {
      contestId: memberContest.id,
      instanceId: instance.id,
      remoteContestId: 'module-test',
      automatic: false,
    },
  });
  await db.accountMapping.create({
    data: {
      registrationId: members.id,
      bindingId: moduleBinding.id,
      username: 'module-user',
      credential: encrypt('fixture'),
      state: 'VERIFIED',
      remoteUserId: 'module-user',
      details: { registrationVersion: members.version },
    },
  });
  const beforeModule = await admin.api(`/contests/${memberContest.id}`);
  const closeModules = {
    ...beforeModule,
    kind: 'ACTIVITY',
    modules: { admissions: false, rooms: false, integrations: false },
  };
  assert.equal(
    (await admin.raw(`/api/v1/contests/${memberContest.id}`, 'PUT', closeModules)).status,
    400,
  );
  await admin.api(`/contests/${memberContest.id}`, 'PUT', {
    ...closeModules,
    confirmModuleChanges: true,
  });
  const changedPreset = await admin.api(`/contests/${memberContest.id}`);
  assert.deepEqual(changedPreset.policy, beforeModule.policy);
  assert.deepEqual(changedPreset.fields, beforeModule.fields);
  assert.equal(await db.seatAssignment.count({ where: { registrationId: members.id } }), 2);
  assert.equal(
    (await admin.raw(`/api/v1/admissions/generate`, 'POST', { registrationIds: [members.id] }))
      .status,
    400,
  );
  assert.equal(
    (await alice.raw(`/api/v1/integrations/registrations/${members.id}/credentials`)).status,
    404,
  );
  const todo = await db.remoteRevocation.findFirstOrThrow({
    where: { registrationId: members.id },
  });
  assert.equal((todo.target as any).remoteContestId, 'module-test');
  await admin.api(`/integrations/revocations/${todo.id}/complete`, 'POST');
  await admin.api(`/integrations/revocations/${todo.id}/complete`, 'POST');
  assert.equal(
    await db.auditEvent.count({
      where: { resourceId: todo.id, action: 'REMOTE_REVOCATION_COMPLETE' },
    }),
    1,
  );
  pass('预设切换保留原配置，关闭功能需确认并撤销本地入口，远端待办完成有去重审计');
  const generationContest = await create({
    policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED' }),
  });
  const generationEntry = await entry(generationContest);
  let pendingGeneration: Promise<Response> | undefined;
  await db.$transaction(
    async (tx) => {
      const key = `seating:${generationContest.id}`;
      await lock(tx, key);
      pendingGeneration = admin.raw('/api/v1/admissions/generate', 'POST', {
        registrationIds: [generationEntry.id],
      });
      await until(
        async () => {
          const rows = await tx.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=(hashtext(${key})::bigint & 4294967295)::oid) AS waiting`;
          return rows[0]!.waiting;
        },
        Boolean,
        10000,
      );
      await tx.contest.update({
        where: { id: generationContest.id },
        data: {
          modules: { admissions: false, rooms: false, integrations: false },
          version: { increment: 1 },
        },
      });
    },
    { timeout: 15000 },
  );
  assert.equal(
    (await pendingGeneration!).status,
    400,
    'A queued generation must recheck current feature configuration after acquiring its locks',
  );
  assert.equal(
    await db.admissionDocument.count({ where: { registrationId: generationEntry.id } }),
    0,
  );
  pass('关闭功能与准考证生成并发时，锁内复核配置，不创建被关闭功能的文档');
  const queueContest = await create();
  await db.registration.createMany({
    data: Array.from({ length: 26 }, (_, i) => ({
      contestId: queueContest.id,
      formVersion: queueContest.formVersion,
      ownerId: alice.user.id,
      status: 'SUBMITTED',
      review: 'PENDING',
      number: i + 1,
      submittedAt: new Date(),
    })),
  });
  const queue = await admin.api(`/registrations/review-queue?contestId=${queueContest.id}`);
  assert.equal(queue.ids.length, 26);
  assert.equal(new Set(queue.ids).size, 26);
  assert.equal(
    (await bob.raw(`/api/v1/registrations/review-queue?contestId=${queueContest.id}`)).status,
    403,
  );
  const templates = await admin.api('/admissions/templates');
  const activeTemplate = templates.find((t: any) => t.contestId === null);
  const templateBody = {
    contestId: queueContest.id,
    name: activeTemplate.name,
    source: activeTemplate.source,
    version: 0,
  };
  await admin.api('/admissions/templates', 'POST', templateBody);
  assert.equal((await admin.raw('/api/v1/admissions/templates', 'POST', templateBody)).status, 409);
  pass('连续审核队列跨越二十条分页且受权限限制，模板版本冲突拒绝覆盖');
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/activity-workflows.json',
    JSON.stringify({ success: true, checks }, null, 2),
  );
} finally {
  await db.contest.updateMany({
    where: { title: { startsWith: `流程验收 ${run} ` } },
    data: { archived: true },
  });
  await db.$disconnect();
  await redis.quit();
}
