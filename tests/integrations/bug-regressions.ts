import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, until } from './client.js';
import { atomicRequest, db, lock } from '../../apps/server/src/db.js';
import { RegistrationService } from '../../apps/server/src/registrations.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { policySchema, type ContestPolicy } from '../../packages/contracts/src/index.js';
import { mailpitBase } from './mailpit.js';
import { putBlob } from '../../apps/server/src/storage.js';

if (config.production) throw new Error('Bug regression fixtures are development-only');
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const contestIds: string[] = [];
const userIds: string[] = [];
const results: { case: string; status: string; error?: string }[] = [];
const selected = process.argv.slice(2);
const known = new Set<string>();

async function check(name: string, fn: () => Promise<void>) {
  known.add(name);
  if (selected.length && !selected.includes(name)) return;
  try {
    await fn();
    results.push({ case: name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ case: name, status: 'FAIL', error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function newcomer(kind: string) {
  const client = new Client();
  const session = await client.register({
    email: `${kind}-${run}@example.test`,
    username: `bug_${kind}_${run}`,
    name: 'BUG 回归用户',
    password: 'BugRegression2026!',
  });
  client.user = session.user;
  client.csrf = session.csrf;
  userIds.push(client.user.id);
  return client;
}

async function mailToken(userId: string, action: 'verify' | 'reset') {
  const account = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const email = action === 'verify' ? (account.pendingEmail ?? account.email) : account.email;
  return until(
    async () => {
      const result = (await (
        await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
      ).json()) as any;
      for (const item of result.messages ?? []) {
        const message = (await (
          await fetch(`${mailpitBase}/api/v1/message/${item.ID}`)
        ).json()) as any;
        const text = String(message.Text),
          marker = `/account/${action}?token=`,
          offset = text.indexOf(marker);
        if (offset >= 0)
          return text.slice(offset + marker.length).match(/^[A-Za-z0-9_-]+/)?.[0] ?? '';
      }
      return '';
    },
    Boolean,
    30000,
  );
}

async function changeEmail(client: Client, kind: string) {
  await client.api('/auth/reauth', 'POST', { password: 'BugRegression2026!' });
  client.user = await client.api('/auth/profile', 'PUT', {
    version: client.user.version,
    name: client.user.name,
    profile: client.user.profile,
    email: `${kind}-new-${run}@example.test`,
  });
  assert.equal(client.user.verified, true);
  assert.ok(client.user.pendingEmail);
}

async function waitingFor(id: string) {
  const [row] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
    AND objid = (hashtext(${id})::bigint & 4294967295)::oid
  ) AS waiting`;
  return row!.waiting;
}
async function raceDeletion(
  client: Client,
  contestId: string,
  registration: { id: string; version: number },
  operation: () => Promise<Response>,
) {
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>((resolve) => (ready = resolve));
  const unlock = new Promise<void>((resolve) => (release = resolve));
  const blocker = db.$transaction(
    async (tx) => {
      await lock(tx, contestId);
      ready();
      await unlock;
    },
    { timeout: 30000 },
  );
  await locked;
  const pending = operation();
  let deletion: Promise<Response> | undefined;
  try {
    // Stop creation after its initial authorization, then race the real cancel endpoint.
    await until(() => waitingFor(contestId), Boolean, 10000);
    let removed = false;
    deletion = client
      .raw(`/api/v1/registrations/${registration.id}/cancel`, 'POST', {
        version: registration.version,
      })
      .then((response) => {
        removed = true;
        return response;
      });
    await until(async () => removed || (await waitingFor(registration.id)), Boolean, 10000);
  } finally {
    release();
    await blocker;
  }
  const [created, deleted] = await Promise.all([pending, deletion!]);
  assert.equal(deleted.status, 201);
  assert.ok([201, 404].includes(created.status));
  return created;
}

try {
  await redis.del('rate:login:::ffff:127.0.0.1', 'rate:login:127.0.0.1');
  const admin = await new Client().login('admin');
  const alice = await new Client().login('alice');
  const bob = await new Client().login('bob');

  async function contest(overrides: Partial<ContestPolicy> = {}) {
    const c = await admin.api('/contests', 'POST', {
      title: `BUG 回归 ${run} ${contestIds.length}`,
      season: '回归测试',
      description: '隔离回归数据',
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      published: true,
      policy: policySchema.parse({ manualReview: false, coachMode: 'DISABLED', ...overrides }),
      fields: [],
    });
    contestIds.push(c.id);
    return c;
  }

  async function submitted(contestId: string, owner = alice) {
    const r = await owner.api('/registrations', 'POST', { contestId });
    return owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  }
  async function voucher(
    registrationId: string,
    reference: string,
    amountCents = 1000,
    owner = alice,
    attachmentId?: string,
    channel = '回归测试',
  ) {
    return owner.api(`/finance/${registrationId}/vouchers`, 'POST', {
      amountCents,
      reference,
      channel,
      payer: '回归付款人',
      paidAt: new Date().toISOString(),
      attachmentId: attachmentId ?? (await owner.upload(registrationId)).id,
    });
  }
  async function confirm(id: string) {
    return admin.api(`/finance/vouchers/${id}/review`, 'POST', { decision: 'CONFIRMED' });
  }

  await check('reversed-payment-releases-active-reference-only', async () => {
    const c = await contest({ feeMode: 'FIXED', feeCents: 1000 });
    const a = await submitted(c.id),
      b = await submitted(c.id, bob);
    await admin.api('/admin/grants', 'POST', {
      userId: bob.user.id,
      level: 'CONTEST',
      contestId: c.id,
      permissions: ['FINANCE'],
    });
    const reference = `reverse-reenter-${run}`;
    const original = await voucher(a.id, reference);
    await confirm(original.id);
    const ledger = await db.ledgerEntry.findUniqueOrThrow({
      where: { sourceId: `voucher:${original.id}` },
    });
    const duplicate = await voucher(b.id, reference, 1000, bob, undefined, '另一渠道');
    const reviewPath = `/api/v1/finance/vouchers/${duplicate.id}/review`;
    assert.equal((await admin.raw(reviewPath, 'POST', { decision: 'CONFIRMED' })).status, 409);
    assert.equal(
      (
        await bob.raw(`/api/v1/finance/${a.id}/vouchers`, 'POST', {
          amountCents: 1000,
          channel: '回归',
          payer: '其他人',
          paidAt: new Date().toISOString(),
          reference: 'different',
          attachmentId: original.attachmentId,
        })
      ).status,
      403,
    );
    const reverse = () =>
      bob.api(`/finance/ledger/${ledger.id}/reverse`, 'POST', { reason: '更正收款归属' });
    await reverse();
    const history = await db.ledgerEntry.findUniqueOrThrow({ where: { id: ledger.id } });
    assert.ok(history.reversedAt);
    assert.equal(history.channelReference, ledger.channelReference);
    assert.equal(history.normalizedReference, ledger.normalizedReference);
    assert.equal(
      (await db.paymentVoucher.findUniqueOrThrow({ where: { id: original.id } })).status,
      'CONFIRMED',
    );
    assert.equal(await db.paymentProofClaim.count({ where: { voucherId: original.id } }), 0);

    // The same proof and reference can be corrected on the same account.
    const corrected = await voucher(a.id, reference, 1000, alice, original.attachmentId);
    await confirm(corrected.id);
    const correctedLedger = await db.ledgerEntry.findUniqueOrThrow({
      where: { sourceId: `voucher:${corrected.id}` },
    });
    await bob.api(`/finance/ledger/${correctedLedger.id}/reverse`, 'POST', {
      reason: '转至正确报名',
    });
    await confirm(duplicate.id);
    // Retrying an old reversal must not release the new account's active claim.
    await reverse();
    const replay = await voucher(a.id, reference);
    assert.equal(
      (
        await admin.raw(`/api/v1/finance/vouchers/${replay.id}/review`, 'POST', {
          decision: 'CONFIRMED',
        })
      ).status,
      409,
    );
    assert.equal((await alice.api(`/finance/accounts/${a.id}`)).netPaidCents, 0);
    assert.equal((await bob.api(`/finance/accounts/${b.id}`)).netPaidCents, 1000);
  });

  await check('save-and-submit-share-contest-seating-lock-order', async () => {
    const c = await contest();
    const a = await alice.api('/registrations', 'POST', { contestId: c.id });
    const b = await bob.api('/registrations', 'POST', { contestId: c.id });
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => (ready = resolve));
    const unlock = new Promise<void>((resolve) => (release = resolve));
    const submitting = atomicRequest(async () => {
      await lock(db, c.id);
      ready();
      await unlock;
      return new RegistrationService().submit(bob.user, b.id, { version: b.version });
    });
    await locked;
    const saving = alice.raw(`/api/v1/registrations/${a.id}`, 'PUT', {
      ...a,
      teamName: '并发保存',
    });
    const pending = Promise.allSettled([saving, submitting]);
    try {
      await until(() => waitingFor(c.id), Boolean, 10000);
    } finally {
      release();
    }
    const [saved, sent] = await pending;
    assert.equal(saved.status, 'fulfilled');
    assert.equal(sent.status, 'fulfilled', sent.status === 'rejected' ? String(sent.reason) : '');
    if (saved.status === 'fulfilled') assert.equal(saved.value.status, 200);
    assert.equal((await bob.api(`/registrations/${b.id}`)).status, 'SUBMITTED');
  });

  await check('personal-form-attachment-survives-cross-role-review', async () => {
    let c = await contest({ manualReview: true });
    c = await admin.api(`/contests/${c.id}`, 'PUT', {
      ...c,
      fields: [
        { key: 'personal_proof', label: '个人证明', scope: 'PERSON', type: 'file', required: true },
      ],
    });
    const upload = new FormData();
    upload.append(
      'file',
      new Blob([`personal proof ${run}`], { type: 'text/plain' }),
      'personal.txt',
    );
    const file = await alice.api('/files?purpose=PERSONAL', 'POST', upload);
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      people: r.people.map((p: any) => ({
        ...p,
        answers: { ...p.answers, personal_proof: file.id },
      })),
    });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    assert.equal(
      await db.teamFile.count({ where: { attachmentId: file.id, registrationId: r.id } }),
      1,
    );
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
    assert.equal(r.eligible, true);
    assert.equal(
      (await db.attachment.findUniqueOrThrow({ where: { id: file.id } })).registrationId,
      null,
    );
    // Knowing another person's file ID or sharing it with a different registration is insufficient.
    let other = await bob.api('/registrations', 'POST', { contestId: c.id });
    other = await bob.api(`/registrations/${other.id}`, 'PUT', {
      ...other,
      people: other.people.map((p: any) => ({
        ...p,
        answers: { ...p.answers, personal_proof: file.id },
      })),
    });
    assert.equal(
      (
        await bob.raw(`/api/v1/registrations/${other.id}/submit`, 'POST', {
          version: other.version,
        })
      ).status,
      403,
    );
  });

  await check('financial-version-preserves-only-still-valid-admissions', async () => {
    const c = await contest({ feeMode: 'FIXED', feeCents: 1000 });
    let r = await submitted(c.id);
    await admin.api('/admin/grants', 'POST', {
      userId: bob.user.id,
      level: 'CONTEST',
      contestId: c.id,
      permissions: ['FINANCE'],
    });
    await confirm((await voucher(r.id, `admission-initial-${run}`)).id);
    r = await alice.api(`/registrations/${r.id}`);
    const template = await db.admissionTemplate.findFirstOrThrow({
      where: { contestId: null, active: true },
      orderBy: { version: 'desc' },
    });
    const bytes = Buffer.from('%PDF-1.4\n% financial version download fixture\n%%EOF\n');
    const ref = await putBlob(`audit-admission-${randomUUID()}`, bytes, 'application/pdf');
    const document = await db.admissionDocument.create({
      data: {
        registrationId: r.id,
        number: `AUDIT-${randomUUID()}`,
        location: '回归考点',
        registrationVersion: r.version,
        templateId: template.id,
        templateVersion: template.version,
        state: 'READY',
        ...ref,
      },
    });
    const stale = await db.admissionDocument.create({
      data: {
        registrationId: r.id,
        number: `OLD-${randomUUID()}`,
        location: '旧资料',
        registrationVersion: r.version - 1,
        templateId: template.id,
        templateVersion: template.version,
        state: 'STALE',
      },
    });
    const extra = await voucher(r.id, `admission-extra-${run}`, 100);
    await confirm(extra.id);
    let current = await alice.api(`/registrations/${r.id}`);
    let ticket = await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(ticket.state, 'READY');
    assert.equal(ticket.registrationVersion, current.version);
    assert.equal((await alice.raw(`/api/v1/admissions/${document.id}/download`)).status, 403);
    await admin.api(`/admissions/${document.id}/release`, 'POST', {});
    const extraLedger = await db.ledgerEntry.findUniqueOrThrow({
      where: { sourceId: `voucher:${extra.id}` },
    });
    await bob.api(`/finance/ledger/${extraLedger.id}/reverse`, 'POST', { reason: '退回多缴部分' });
    current = await alice.api(`/registrations/${r.id}`);
    ticket = await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(current.eligible, true);
    assert.equal(ticket.state, 'RELEASED');
    assert.equal(ticket.registrationVersion, current.version);
    assert.ok((await alice.api('/admissions/mine')).some((a: any) => a.id === ticket.id));
    const download = await alice.raw(`/api/v1/admissions/${ticket.id}/download`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(
      (await db.admissionDocument.findUniqueOrThrow({ where: { id: stale.id } })).state,
      'STALE',
    );

    const refund = await alice.api(`/finance/${r.id}/refunds`, 'POST', {
      amountCents: 1,
      reason: '验证余额不足使资格失效',
    });
    await admin.api(`/finance/refunds/${refund.id}/review`, 'POST', { decision: 'APPROVED' });
    await admin.api(`/finance/refunds/${refund.id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: `admission-refund-${run}`,
    });
    assert.equal((await alice.api(`/registrations/${r.id}`)).eligible, false);
    assert.equal(
      (await db.admissionDocument.findUniqueOrThrow({ where: { id: ticket.id } })).state,
      'STALE',
    );
    assert.equal((await alice.raw(`/api/v1/admissions/${ticket.id}/download`)).status, 403);
  });

  await check('member-name-rejects-whitespace-and-validates-legacy-data', async () => {
    const c = await contest();
    let r = await submitted(c.id);
    const path = `/api/v1/registrations/${r.id}/people/${r.people[0].id}`;
    for (const name of ['   ', '\t\n', '\u3000'])
      assert.equal(
        (await alice.raw(path, 'PUT', { version: r.version, name, answers: r.people[0].answers }))
          .status,
        400,
      );
    r = await alice.api(path.replace('/api/v1', ''), 'PUT', {
      version: r.version,
      name: '  有效姓名  ',
      answers: r.people[0].answers,
    });
    assert.equal(r.people[0].name, '有效姓名');
    // Previously persisted bad names must not pass a later resubmission or review.
    await db.registrationPerson.update({ where: { id: r.people[0].id }, data: { name: '   ' } });
    assert.equal(
      (await alice.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', { version: r.version }))
        .status,
      400,
    );
  });

  await check('required-text-rejects-whitespace-without-rejecting-zero-or-false', async () => {
    let c = await contest();
    c = await admin.api(`/contests/${c.id}`, 'PUT', {
      ...c,
      fields: [
        {
          key: 'required_text',
          label: '必填说明',
          scope: 'REGISTRATION',
          type: 'text',
          required: true,
        },
        {
          key: 'required_number',
          label: '必填数字',
          scope: 'REGISTRATION',
          type: 'number',
          required: true,
        },
        {
          key: 'required_bool',
          label: '必填开关',
          scope: 'REGISTRATION',
          type: 'boolean',
          required: true,
        },
      ],
    });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    for (const text of ['   ', '\t\n', '\u3000']) {
      r = await alice.api(`/registrations/${r.id}`, 'PUT', {
        ...r,
        answers: {
          registration: { required_text: text, required_number: 0, required_bool: false },
        },
      });
      assert.equal(
        (await alice.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', { version: r.version }))
          .status,
        400,
      );
    }
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      answers: {
        registration: { required_text: '有效内容', required_number: 0, required_bool: false },
      },
    });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    assert.equal(r.eligible, true);
    assert.equal(r.answers.registration.required_number, 0);
    assert.equal(r.answers.registration.required_bool, false);
  });

  await check('duplicate-member-identifiers', async () => {
    const c = await contest({ mode: 'TEAM', memberMode: 'MANUAL', maxMembers: 3 });
    const r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const response = await alice.raw(`/api/v1/registrations/${r.id}`, 'PUT', {
      ...r,
      people: [r.people[0], { ...r.people[0], name: '重复成员', captain: false }],
    });
    const current = await alice.api(`/registrations/${r.id}`);
    assert.equal(response.status, 400, 'Repeated member IDs must not overwrite the captain');
    assert.equal(current.version, r.version);
    assert.equal(current.people.length, 1);
    assert.equal(current.people[0].captain, true);
  });

  await check('unchanged-room-preserves-admission', async () => {
    let c = await contest();
    c = await admin.api(`/contests/${c.id}`, 'PUT', {
      ...c,
      fields: [],
      modules: { ...c.modules, admissions: true, rooms: true },
    });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const room = await admin.api(`/contests/${c.id}/rooms`, 'POST', {
      name: '核对考场',
      capacity: 20,
    });
    const request = { registrationIds: [r.id] };
    const preview = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', request);
    await admin.api(`/contests/${c.id}/seating/commit`, 'POST', {
      ...request,
      seatingVersion: preview.seatingVersion,
      registrationVersions: preview.registrationVersions,
    });
    // Seed a released document to isolate invalidation from the PDF renderer.
    const document = await db.admissionDocument.create({
      data: {
        registrationId: r.id,
        number: `NOOP-${run}`,
        location: '',
        room: room.name,
        registrationVersion: r.version,
        templateId: randomUUID(),
        templateVersion: 1,
        state: 'READY',
        releasedAt: new Date(),
      },
    });
    const before = await admin.api(`/contests/${c.id}/rooms`);
    const saved = await admin.api(`/contests/${c.id}/rooms/${room.id}`, 'PUT', room);
    assert.equal(
      (await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } })).state,
      'READY',
      'Saving an unchanged room must not revoke existing admission documents',
    );
    assert.equal(saved.version, room.version);
    assert.equal(
      (await admin.api(`/contests/${c.id}/rooms`)).seatingVersion,
      before.seatingVersion,
    );
    const repeat = {
      registrationIds: [r.id],
      replace: true,
      assignments: before.seats.map(({ registrationId, personId, roomId, seat }: any) => ({
        registrationId,
        personId,
        roomId,
        seat,
      })),
    };
    const repeatedPreview = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', repeat);
    await admin.api(`/contests/${c.id}/seating/commit`, 'POST', {
      ...repeat,
      seatingVersion: repeatedPreview.seatingVersion,
      registrationVersions: repeatedPreview.registrationVersions,
    });
    assert.equal(
      (await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } })).state,
      'READY',
      'Reconfirming identical seats must not revoke existing admission documents',
    );
    await admin.api(`/contests/${c.id}/rooms/${room.id}`, 'PUT', { ...saved, location: '新地点' });
    assert.equal(
      (await db.admissionDocument.findUniqueOrThrow({ where: { id: document.id } })).state,
      'STALE',
    );
  });

  await check('registration-ticket-attachment-isolation', async () => {
    const c = await contest();
    await admin.api(`/contests/${c.id}`, 'PUT', {
      ...c,
      fields: [
        { scope: 'REGISTRATION', key: 'proof', label: '报名材料', type: 'file', required: true },
      ],
    });
    const ticket = await alice.api('/support', 'POST', {
      contestId: c.id,
      title: '独立私有工单',
      category: '回归',
      text: '此材料仅属于工单',
    });
    const form = new FormData();
    form.append(
      'file',
      new Blob(['private ticket material'], { type: 'text/plain' }),
      'ticket.txt',
    );
    const file = await alice.api(`/files?ticketId=${ticket.id}`, 'POST', form);
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      answers: { registration: { proof: file.id } },
    });
    const response = await alice.raw(`/api/v1/registrations/${r.id}/submit`, 'POST', {
      version: r.version,
    });
    assert.equal(
      response.status,
      403,
      'A support attachment must not become registration material',
    );
    assert.equal(
      (await db.attachment.findUniqueOrThrow({ where: { id: file.id } })).registrationId,
      null,
    );
    assert.equal(await db.teamFile.count({ where: { attachmentId: file.id } }), 0);
    const personal = await alice.upload();
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      answers: { registration: { proof: personal.id } },
    });
    await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const other = await bob.api('/registrations', 'POST', { contestId: c.id });
    const sharedOwnerFile = await admin.upload(other.id);
    let own = await admin.api('/registrations', 'POST', { contestId: c.id });
    // Management cannot edit drafts. Seed a malicious stored reference to exercise
    // submission validation even when the uploader owns the other registration's file.
    await db.registration.update({
      where: { id: own.id },
      data: { answers: { registration: { proof: sharedOwnerFile.id } } },
    });
    own = await admin.api(`/registrations/${own.id}`);
    assert.equal(
      (await admin.raw(`/api/v1/registrations/${own.id}/submit`, 'POST', { version: own.version }))
        .status,
      403,
      'Owning a file must not permit rebinding another registration exclusive attachment',
    );
    assert.equal(
      (await db.attachment.findUniqueOrThrow({ where: { id: sharedOwnerFile.id } })).registrationId,
      other.id,
    );
  });

  await check('distribution-registration-deletion-race', async () => {
    const c = await contest();
    const r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const form = new FormData();
    form.append('file', new Blob(['activity material'], { type: 'text/plain' }), 'material.txt');
    const file = await admin.api(`/files?contestId=${c.id}&purpose=CONTEST_PRIVATE`, 'POST', form);
    const body = { attachmentId: file.id, registrationIds: [r.id] };
    await admin.api(`/contests/${c.id}/files/distribute`, 'POST', body);
    let ready!: () => void, release!: () => void;
    const removed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the real cancellation transaction just before commit. The old assignment's
    // unique index synchronizes a concurrent distribution without timing sleeps.
    const deletion = atomicRequest(async () => {
      await new RegistrationService().cancel(alice.user, r.id, { version: r.version });
      ready();
      await resume;
    });
    await removed;
    let completed = false;
    const distribution = admin
      .raw(`/api/v1/contests/${c.id}/files/distribute`, 'POST', body)
      .then((response) => {
        completed = true;
        return response;
      });
    try {
      await until(
        async () => {
          const [row] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND query LIKE '%INSERT%TeamFile%'
        ) AS waiting`;
          return completed || row!.waiting || (await waitingFor(r.id));
        },
        Boolean,
        10000,
      );
    } finally {
      release();
      await deletion;
    }
    const response = await distribution;
    try {
      assert.equal(
        await db.teamFile.count({ where: { registrationId: r.id } }),
        0,
        'A concurrent distribution must not recreate references to a deleted registration',
      );
      assert.equal(response.status, 400);
    } finally {
      await db.teamFile.deleteMany({ where: { registrationId: r.id } });
    }
  });

  await check('old-verification-link', async () => {
    const client = await newcomer('verify');
    await changeEmail(client, 'verify-first');
    const old = await mailToken(client.user.id, 'verify');
    await changeEmail(client, 'verify');
    const response = await client.raw('/api/v1/auth/verify', 'POST', { token: old });
    assert.equal(response.status, 400, 'A previous mailbox must not verify the new address');
    assert.equal((await client.api('/auth/me')).user.verified, true);
    assert.ok((await client.api('/auth/me')).user.pendingEmail);
    const current = await mailToken(client.user.id, 'verify');
    await client.api('/auth/verify', 'POST', { token: current });
    assert.equal((await client.api('/auth/me')).user.verified, true);
  });

  await check('old-reset-link', async () => {
    const client = await newcomer('reset');
    await client.api('/auth/forgot', 'POST', { email: client.user.email });
    const old = await mailToken(client.user.id, 'reset');
    await changeEmail(client, 'reset');
    const response = await client.raw('/api/v1/auth/reset', 'POST', {
      token: old,
      password: 'ChangedByOldMailbox2026!',
    });
    assert.equal(response.status, 400, 'A previous mailbox must not reset the account password');
    assert.equal((await client.api('/auth/me')).user.id, client.user.id);
    await client.api('/auth/verify', 'POST', { token: await mailToken(client.user.id, 'verify') });
    client.user = (await client.api('/auth/me')).user;
    await client.api('/auth/forgot', 'POST', { email: client.user.email });
    const current = await mailToken(client.user.id, 'reset');
    await client.api('/auth/reset', 'POST', {
      token: current,
      password: 'CurrentMailbox2026!',
    });
    assert.equal((await client.api('/auth/me')).user, null);
    await new Client().login(client.user.email, 'CurrentMailbox2026!');
  });

  await check('cancellation-eligibility-event', async () => {
    for (const feeCents of [0, 1000]) {
      const c = await contest({ feeMode: feeCents ? 'FIXED' : 'FREE', feeCents });
      let r = await alice.api('/registrations', 'POST', { contestId: c.id });
      r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
      if (feeCents) {
        const proof = await alice.upload(r.id);
        const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
          amountCents: feeCents,
          channel: '回归测试',
          payer: '示例付款人',
          reference: `cancel-${run}`,
          paidAt: new Date().toISOString(),
          attachmentId: proof.id,
        });
        await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', {
          decision: 'CONFIRMED',
        });
        r = await alice.api(`/registrations/${r.id}`);
      }
      assert.equal(r.eligible, true);
      const oldId = r.id;
      const receipt = await alice.api(`/registrations/${r.id}/cancel`, 'POST', {
        version: r.version,
      });
      assert.equal(receipt.deleted, true);
      assert.equal((await alice.raw(`/api/v1/registrations/${oldId}`)).status, 404);
      const removed = await db.outboxEvent.findFirstOrThrow({
        where: { resourceId: oldId, type: 'REGISTRATION_REMOVED' },
      });
      assert.equal((removed.payload as any).deleted, true);
      if (feeCents)
        assert.equal((await alice.api(`/finance/accounts/${oldId}`)).netPaidCents, feeCents);
    }
  });

  await check('unofficial-review-before-payment', async () => {
    const c = await contest({
      allowUnofficial: true,
      feeMode: 'FIXED',
      feeCents: 1000,
      paymentSequence: 'REVIEW_FIRST',
    });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      participationType: 'UNOFFICIAL',
    });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    assert.equal(r.review, 'PENDING');
    const proof = await alice.upload(r.id);
    const input = {
      amountCents: 1000,
      channel: '回归测试',
      payer: '示例付款人',
      reference: `bug-${run}`,
      paidAt: new Date().toISOString(),
      attachmentId: proof.id,
    };
    const response = await alice.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', input);
    assert.equal(response.status, 400, 'Mandatory unofficial review must precede payment');
    r = await admin.api(`/registrations/${r.id}/review`, 'POST', {
      version: r.version,
      decision: 'APPROVED',
    });
    const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', input);
    assert.equal(voucher.status, 'PENDING');
  });

  await check('team-member-support-list', async () => {
    const c = await contest({ mode: 'TEAM', minMembers: 2, maxMembers: 2 });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const invite = await alice.api(`/registrations/${r.id}/invites`, 'POST', {
      kind: 'MEMBER',
      targetEmail: bob.user.email,
    });
    const token = new URL(invite.url).pathname.split('/').at(-1);
    await bob.api(`/invitations/${token}/accept`, 'POST', {});
    const ticket = await alice.api('/support', 'POST', {
      registrationId: r.id,
      title: `团队工单 ${run}`,
      category: '报名',
      text: '团队成员应能在工单列表找到可访问的工单',
    });
    assert.equal((await bob.api(`/support/${ticket.id}`)).id, ticket.id);
    const list = await bob.api(`/support?page=1&pageSize=20&contestId=${c.id}`);
    assert.ok(
      list.items.some((row: any) => row.id === ticket.id),
      'Team members must be able to find the shared ticket in their list',
    );
    const privateTicket = await admin.api('/support', 'POST', {
      title: `私有工单 ${run}`,
      category: '账号',
      text: '不得泄露无关联工单',
    });
    assert.equal((await bob.raw(`/api/v1/support/${privateTicket.id}`)).status, 403);
    const shared = await bob.api(`/support?page=1&pageSize=20&search=${run}`);
    assert.ok(shared.items.some((row: any) => row.id === ticket.id));
    assert.ok(!shared.items.some((row: any) => row.id === privateTicket.id));
    r = await alice.api(`/registrations/${r.id}`);
    await alice.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      people: r.people.filter((person: any) => person.userId !== bob.user.id),
    });
    assert.equal((await bob.raw(`/api/v1/support/${ticket.id}`)).status, 403);
    assert.equal((await bob.api(`/support?page=1&pageSize=20&contestId=${c.id}`)).items.length, 0);
  });
  await check('registration-upload-deletion-race', async () => {
    const c = await contest();
    const r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const form = new FormData();
    form.append('file', new Blob(['orphan upload fixture'], { type: 'text/plain' }), 'race.txt');
    await raceDeletion(alice, c.id, r, () =>
      alice.raw(`/api/v1/files?registrationId=${r.id}&purpose=TEAM`, 'POST', form),
    );
    try {
      assert.equal(
        await db.attachment.count({ where: { registrationId: r.id } }),
        0,
        'Concurrent upload must not leave attachments pointing at a deleted registration',
      );
      assert.equal(await db.teamFile.count({ where: { registrationId: r.id } }), 0);
    } finally {
      for (const file of await db.attachment.findMany({
        where: { registrationId: r.id, deletedAt: null },
      }))
        await alice.api(`/files/${file.id}`, 'DELETE');
      await db.teamFile.deleteMany({ where: { registrationId: r.id } });
    }
  });

  await check('support-creation-deletion-race', async () => {
    const c = await contest();
    const r = await alice.api('/registrations', 'POST', { contestId: c.id });
    const response = await raceDeletion(alice, c.id, r, () =>
      alice.raw('/api/v1/support', 'POST', {
        registrationId: r.id,
        title: '删除并发工单',
        category: '回归',
        text: '独立工单仍须可访问',
      }),
    );
    try {
      assert.equal(
        await db.supportTicket.count({ where: { registrationId: r.id } }),
        0,
        'Concurrent support creation must not leave a link to a deleted registration',
      );
      if (response.status === 201) {
        const ticket = await response.json();
        assert.equal((await alice.api(`/support/${ticket.id}`)).registrationId, null);
      }
    } finally {
      await db.supportTicket.updateMany({
        where: { registrationId: r.id },
        data: { registrationId: null },
      });
    }
  });

  await check('finance-current-invoice-policy', async () => {
    const c = await contest({ feeMode: 'FIXED', feeCents: 1000 });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const current = await admin.api(`/contests/${c.id}`);
    await admin.api(`/contests/${c.id}`, 'PUT', {
      ...current,
      policy: {
        ...current.policy,
        invoicesEnabled: true,
        invoiceTypes: ['SPECIAL'],
        invoiceRequiredFields: ['phone'],
      },
    });
    const account = await alice.api(`/finance/accounts/${r.id}`);
    assert.equal(
      account.invoicePolicy?.invoicesEnabled,
      true,
      'The finance form must use the current invoicing policy',
    );
    assert.deepEqual(account.invoicePolicy.invoiceTypes, ['SPECIAL']);
    assert.deepEqual(account.invoicePolicy.invoiceRequiredFields, ['phone']);
    assert.equal(
      account.policy.feeCents,
      1000,
      'Historical fee calculations must retain their original policy',
    );
  });

  await check('financial-attachment-context', async () => {
    const other = await contest();
    const c = await contest({ feeMode: 'FIXED', feeCents: 1000 });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const ticket = await alice.api('/support', 'POST', {
      contestId: other.id,
      title: '独立工单附件',
      category: '咨询',
      text: '隔离附件归属回归',
    });
    const form = new FormData();
    form.append(
      'file',
      new Blob(['private support material'], { type: 'text/plain' }),
      'ticket.txt',
    );
    const file = await alice.api(`/files?ticketId=${ticket.id}`, 'POST', form);
    const response = await alice.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', {
      amountCents: 1000,
      channel: '回归',
      payer: '测试用户',
      paidAt: new Date().toISOString(),
      attachmentId: file.id,
    });
    assert.equal(
      response.status,
      403,
      'An independent ticket attachment cannot be rebound as another activitys financial proof',
    );
    assert.equal(await db.paymentVoucher.count({ where: { attachmentId: file.id } }), 0);
    assert.equal(
      (await db.attachment.findUniqueOrThrow({ where: { id: file.id } })).registrationId,
      null,
    );
    let own = await admin.api('/registrations', 'POST', { contestId: c.id });
    own = await admin.api(`/registrations/${own.id}/submit`, 'POST', { version: own.version });
    const scopedUpload = new FormData();
    scopedUpload.append(
      'file',
      new Blob(['another activity'], { type: 'text/plain' }),
      'scoped.txt',
    );
    const scopedFile = await admin.api(
      `/files?contestId=${other.id}&purpose=CONTEST_PRIVATE`,
      'POST',
      scopedUpload,
    );
    const proof = {
      amountCents: 1000,
      channel: '回归',
      payer: '测试用户',
      paidAt: new Date().toISOString(),
      attachmentId: scopedFile.id,
    };
    assert.equal(
      (await admin.raw(`/api/v1/finance/${own.id}/vouchers`, 'POST', proof)).status,
      403,
      'Even an administrators own file must retain its activity scope',
    );
    const personal = await alice.upload();
    assert.equal(
      (
        await alice.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', {
          ...proof,
          attachmentId: personal.id,
        })
      ).status,
      201,
      'Unbound personal uploads remain valid financial proof',
    );
  });

  await check('removed-registration-financial-notifications', async () => {
    const c = await contest({
      feeMode: 'FIXED',
      feeCents: 1000,
      refundsEnabled: true,
      invoicesEnabled: true,
    });
    let r = await alice.api('/registrations', 'POST', { contestId: c.id });
    r = await alice.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const file = await alice.upload(r.id);
    const voucher = await alice.api(`/finance/${r.id}/vouchers`, 'POST', {
      amountCents: 1000,
      channel: '回归',
      payer: '测试用户',
      paidAt: new Date().toISOString(),
      attachmentId: file.id,
    });
    await admin.api(`/finance/vouchers/${voucher.id}/review`, 'POST', { decision: 'CONFIRMED' });
    r = await alice.api(`/registrations/${r.id}`);
    await alice.api(`/registrations/${r.id}/cancel`, 'POST', { version: r.version });
    assert.ok(
      await db.outboxEvent.findFirst({
        where: {
          resourceId: r.id,
          type: 'MAIL',
          payload: { path: ['text'], string_contains: '缴费核账' },
        },
      }),
      'Financial notifications queued before deletion must also survive',
    );
    await alice.api(`/finance/${r.id}/refunds`, 'POST', {
      amountCents: 100,
      reason: '财务通知回归',
    });
    await alice.api(`/finance/${r.id}/invoices`, 'POST', {
      title: '测试个人',
      titleType: 'PERSON',
      invoiceType: 'NORMAL',
      amountCents: 500,
      email: alice.user.email,
    });
    const notices = await db.outboxEvent.findMany({ where: { resourceId: r.id, type: 'MAIL' } });
    for (const text of ['退款申请已提交', '开票申请已提交']) {
      const notice = notices.find((n) => String((n.payload as any).text).includes(text));
      assert.ok(notice, `Deleted registrations still need deliverable notification: ${text}`);
      assert.equal((notice.payload as any).actionPath, `/finance/${r.id}`);
      assert.equal((notice.payload as any).finance, true);
    }
    const delivered = await until(
      async () => {
        const search = (await (
          await fetch(
            `${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${alice.user.email}`)}`,
          )
        ).json()) as { messages?: { ID: string }[] };
        return Promise.all(
          (search.messages ?? []).slice(0, 30).map(
            async (m) =>
              (await (await fetch(`${mailpitBase}/api/v1/message/${m.ID}`)).json()) as {
                Text?: string;
              },
          ),
        );
      },
      (messages) =>
        ['退款申请已提交', '开票申请已提交'].every((text) =>
          messages.some((m) => m.Text?.includes(text) && m.Text.includes(`/finance/${r.id}`)),
        ),
      30000,
    );
    assert.ok(delivered.length);
  });

  await check('support-attachment-context', async () => {
    const a = await contest(),
      b = await contest();
    const ticket = await admin.api('/support', 'POST', {
      contestId: b.id,
      title: '材料隔离工单',
      category: '回归',
      text: '独立活动工单',
    });
    const responses: number[] = [];
    for (const replying of [false, true]) {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['activity private file'], { type: 'text/plain' }),
        'private.txt',
      );
      const file = await admin.api(
        `/files?contestId=${a.id}&purpose=CONTEST_PRIVATE`,
        'POST',
        form,
      );
      const response = replying
        ? await admin.raw(`/api/v1/support/${ticket.id}/messages`, 'POST', {
            version: ticket.version,
            text: '不得跨活动移动附件',
            attachments: [file.id],
          })
        : await admin.raw('/api/v1/support', 'POST', {
            contestId: b.id,
            title: '附件错误归属',
            category: '回归',
            text: '不得跨活动移动附件',
            attachments: [file.id],
          });
      responses.push(response.status);
    }
    assert.deepEqual(
      responses,
      [403, 403],
      'Creating and replying to tickets must preserve the attachment activity scope',
    );
  });
} finally {
  if (contestIds.length)
    await db.contest.updateMany({ where: { id: { in: contestIds } }, data: { archived: true } });
  if (userIds.length) {
    await db.emailToken.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile('.runtime/reports/bug-regressions.json', JSON.stringify({ results }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
assert.ok(
  results.length && selected.every((name) => known.has(name)),
  'Unknown or empty bug regression selection',
);
if (results.some((row) => row.status === 'FAIL')) process.exitCode = 1;
