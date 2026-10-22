import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { mailpitBase } from './mailpit.js';
import { Client, until, base } from './client.js';
import { db, audit } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
import { config } from '../../apps/server/src/config.js';
import { pendingPdfJobs } from '../../apps/server/src/job-scheduling.js';
import { cleanSpool, retainTemporaryData } from '../../apps/server/src/retention.js';
import { putBlob, reconcileStorage } from '../../apps/server/src/storage.js';
import { policySchema } from '../../packages/contracts/src/index.js';

if (process.env.NXOPA_ISOLATED_TEST_DATABASE !== '1')
  throw new Error('Run through test:full with an isolated database');
const contestIds: string[] = [];
const checks: string[] = [],
  failures: string[] = [],
  stamp = randomUUID().slice(0, 8);
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    checks.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).stack}`);
    console.error(`FAIL ${name}:`, (error as Error).message);
  }
}
const admin = await new Client().login('admin'),
  finance = await new Client().login('bob');
const owner = new Client(),
  oldEmail = `audit-${stamp}@example.test`,
  password = 'AuditFixture2026!';
await owner.register({
  email: oldEmail,
  username: `audit_${stamp}`,
  name: '审计回归用户',
  password,
});
await owner.completeProfile();
async function contest(feeCents = 0, policy: Record<string, unknown> = {}) {
  const c = await admin.api('/contests', 'POST', {
    title: `审计 ${stamp} ${randomUUID().slice(0, 8)}`,
    season: '测试',
    description: '隔离回归',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    opensAt: new Date(Date.now() - 60000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    published: true,
    policy: policySchema.parse({
      feeMode: feeCents ? 'FIXED' : 'FREE',
      feeCents,
      refundsEnabled: true,
      manualReview: false,
      ...policy,
    }),
    fields: [],
  });
  contestIds.push(c.id);
  return c;
}
async function registration(c: any) {
  const r = await owner.api('/registrations', 'POST', { contestId: c.id });
  await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
  return (
    (await owner.api(`/registrations/${r.id}`)).registration ??
    (await db.registration.findUniqueOrThrow({ where: { id: r.id } }))
  );
}
async function grant(contestId: string, permissions: string[]) {
  return admin.api('/admin/grants', 'POST', {
    userId: finance.user.id,
    level: 'CONTEST',
    contestId,
    permissions,
  });
}
async function voucher(r: any, amountCents: number, reference: string, channel = '银行转账') {
  const file = await owner.upload(r.id);
  return owner.api(`/finance/${r.id}/vouchers`, 'POST', {
    amountCents,
    channel,
    reference,
    payer: '测试付款人',
    paidAt: new Date().toISOString(),
    attachmentId: file.id,
  });
}
async function mailboxToken(email: string) {
  return until(
    async () => {
      const search = (await (
        await fetch(`${mailpitBase}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
      ).json()) as any;
      if (!search.messages?.[0]) return '';
      const message = (await (
        await fetch(`${mailpitBase}/api/v1/message/${search.messages[0].ID}`)
      ).json()) as any;
      return String(message.Text).match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
    },
    Boolean,
    30000,
  );
}
try {
  await check(
    'H1: stolen session cannot change mailbox; pending mailbox cannot reset password',
    async () => {
      const current = (await owner.api('/auth/me')).user,
        email = `pending-${stamp}@example.test`;
      const body = {
        version: current.version,
        name: current.name,
        profile: current.profile,
        email,
      };
      assert.equal((await owner.raw('/api/v1/auth/profile', 'PUT', body)).status, 403);
      await owner.api('/auth/reauth', 'POST', { password });
      await owner.api('/auth/profile', 'PUT', body);
      const pending = (await owner.api('/auth/me')).user;
      assert.equal(pending.email, oldEmail);
      assert.equal(pending.pendingEmail, email);
      assert.equal(pending.verified, true);
      await owner.api('/auth/forgot', 'POST', { email });
      assert.equal(
        await db.emailToken.count({
          where: { userId: owner.user.id, purpose: 'RESET', usedAt: null },
        }),
        0,
      );
      const token = await mailboxToken(email);
      const other = await new Client().login(oldEmail, password);
      await owner.api('/auth/verify', 'POST', { token });
      assert.equal((await owner.api('/auth/me')).user.email, email);
      assert.equal((await other.api('/auth/me')).user, null);
      assert.ok(
        await db.auditEvent.count({ where: { actorId: owner.user.id, action: 'EMAIL_CHANGE' } }),
      );
    },
  );
  await check('H2: split refunds require a second reviewer after cumulative fee', async () => {
    const c = await contest(100),
      r = await registration(c);
    await grant(c.id, ['FINANCE']);
    const v = await voucher(r, 300, `split-${stamp}`);
    await finance.api(`/finance/vouchers/${v.id}/review`, 'POST', { decision: 'CONFIRMED' });
    const refunds = [];
    for (let i = 0; i < 3; i++)
      refunds.push(
        await owner.api(`/finance/${r.id}/refunds`, 'POST', {
          amountCents: 100,
          reason: '多付款退还',
        }),
      );
    for (const x of refunds)
      await finance.api(`/finance/refunds/${x.id}/review`, 'POST', { decision: 'APPROVED' });
    await finance.api(`/finance/refunds/${refunds[0].id}/review`, 'POST', {
      decision: 'COMPLETED',
      reference: `refund-${stamp}-0`,
    });
    for (const [i, x] of refunds.slice(1).entries()) {
      const body = { decision: 'COMPLETED', reference: `refund-${stamp}-${i + 1}` };
      assert.equal(
        (await finance.raw(`/api/v1/finance/refunds/${x.id}/review`, 'POST', body)).status,
        403,
      );
      await admin.api(`/finance/refunds/${x.id}/review`, 'POST', body);
      assert.equal(
        (await db.refund.findUniqueOrThrow({ where: { id: x.id } })).secondReviewerId,
        admin.user.id,
      );
    }
    assert.equal(
      (await db.financeAccount.findUniqueOrThrow({ where: { id: r.id } })).netPaidCents,
      0,
    );
  });
  await check(
    'H3: normalized references and reuploaded identical proof cannot double-credit',
    async () => {
      const c = await contest(100),
        r = await registration(c);
      await grant(c.id, ['FINANCE']);
      const first = await voucher(r, 100, ' ＡＢＣ　１２３ ', ' 银行转账 ');
      await finance.api(`/finance/vouchers/${first.id}/review`, 'POST', { decision: 'CONFIRMED' });
      const second = await voucher(r, 100, 'abc 123', '其他渠道');
      assert.equal(
        (
          await finance.raw(`/api/v1/finance/vouchers/${second.id}/review`, 'POST', {
            decision: 'CONFIRMED',
          })
        ).status,
        409,
      );
      assert.equal(
        (await db.financeAccount.findUniqueOrThrow({ where: { id: r.id } })).netPaidCents,
        100,
      );
      const upload = async () => {
        const body = new FormData();
        body.append('file', new Blob([`same-proof-${stamp}`], { type: 'text/plain' }), 'proof.txt');
        return owner.api(`/files?registrationId=${r.id}`, 'POST', body);
      };
      const a = await upload(),
        b = await upload(),
        input = {
          amountCents: 100,
          reference: `proof-${stamp}`,
          channel: '银行',
          payer: '测试',
          paidAt: new Date().toISOString(),
        };
      await owner.api(`/finance/${r.id}/vouchers`, 'POST', { ...input, attachmentId: a.id });
      assert.equal(
        (
          await owner.raw(`/api/v1/finance/${r.id}/vouchers`, 'POST', {
            ...input,
            reference: `other-${stamp}`,
            attachmentId: b.id,
          })
        ).status,
        409,
      );
      // Reproduce the post-upgrade shape in which only the first legacy claim has its digest filled.
      const legacyUpload = async () => {
        const data = new FormData();
        data.append('file', new Blob([`legacy-proof-${stamp}`], { type: 'text/plain' }), 'old.txt');
        return owner.api(`/files?registrationId=${r.id}`, 'POST', data);
      };
      const legacyA = await legacyUpload(),
        legacyB = await legacyUpload();
      const digest = (await db.attachment.findUniqueOrThrow({ where: { id: legacyA.id } })).sha256;
      const legacy = [];
      for (const [i, file] of [legacyA, legacyB].entries()) {
        const v = await db.paymentVoucher.create({
          data: {
            registrationId: r.id,
            amountCents: 50,
            channel: 'legacy',
            reference: `legacy-${stamp}-${i}`,
            payer: '历史付款人',
            paidAt: new Date(),
            attachmentId: file.id,
            createdBy: owner.user.id,
          },
        });
        await db.paymentProofClaim.create({
          data: {
            attachmentId: file.id,
            voucherId: v.id,
            ...(i === 0 ? { registrationId: r.id, proofSha256: digest } : {}),
          },
        });
        legacy.push(v);
      }
      await finance.api(`/finance/vouchers/${legacy[0].id}/review`, 'POST', {
        decision: 'CONFIRMED',
      });
      assert.equal(
        (
          await finance.raw(`/api/v1/finance/vouchers/${legacy[1].id}/review`, 'POST', {
            decision: 'CONFIRMED',
          })
        ).status,
        409,
      );
      for (const reference of ['ΟΣ', 'İ', 'AB' + String.fromCharCode(0xfeff) + 'CD']) {
        const oldFile = await owner.upload(r.id),
          v = await db.paymentVoucher.create({
            data: {
              registrationId: r.id,
              amountCents: 10,
              channel: '旧银行',
              reference,
              payer: '历史付款人',
              paidAt: new Date(),
              attachmentId: oldFile.id,
              createdBy: owner.user.id,
              status: 'CONFIRMED',
            },
          });
        const canonical = (
          await db.$queryRaw<
            { value: string }[]
          >`SELECT nxopa_normalize_payment_text(${reference}) AS value`
        )[0].value;
        await db.ledgerEntry.create({
          data: {
            registrationId: r.id,
            contestId: c.id,
            kind: 'PAYMENT',
            amountCents: 10,
            sourceId: `voucher:${v.id}`,
            actorId: finance.user.id,
            note: '升级前记录',
            normalizedReference: `payment:${canonical}`,
          },
        });
        await db.financeAccount.update({
          where: { id: r.id },
          data: { netPaidCents: { increment: 10 }, version: { increment: 1 } },
        });
        await db.registration.update({
          where: { id: r.id },
          data: { netPaidCents: { increment: 10 }, version: { increment: 1 } },
        });
        const duplicate = await voucher(r, 10, reference);
        assert.equal(
          (
            await finance.raw(`/api/v1/finance/vouchers/${duplicate.id}/review`, 'POST', {
              decision: 'CONFIRMED',
            })
          ).status,
          409,
        );
      }
      const before = (await db.financeAccount.findUniqueOrThrow({ where: { id: r.id } }))
        .netPaidCents;
      const historical = [];
      for (let i = 0; i < 2; i++) {
        const file = await owner.upload(r.id),
          v = await db.paymentVoucher.create({
            data: {
              registrationId: r.id,
              amountCents: 20,
              channel: '历史已解决重复款',
              reference: `resolved-${stamp}`,
              payer: '历史付款人',
              paidAt: new Date(),
              attachmentId: file.id,
              createdBy: owner.user.id,
              status: 'CONFIRMED',
            },
          });
        historical.push(
          await db.ledgerEntry.create({
            data: {
              registrationId: r.id,
              contestId: c.id,
              kind: 'PAYMENT',
              amountCents: 20,
              sourceId: `voucher:${v.id}`,
              actorId: finance.user.id,
              note: '历史记录',
              normalizedReference: i === 1 ? `payment:resolved-${stamp}` : null,
              requiresReconciliation: i === 1,
            },
          }),
        );
      }
      await db.financeAccount.update({
        where: { id: r.id },
        data: { netPaidCents: { increment: 40 }, reconciliationRequired: true },
      });
      await db.registration.update({
        where: { id: r.id },
        data: { netPaidCents: { increment: 40 } },
      });
      await admin.api(`/finance/ledger/${historical[0].id}/reverse`, 'POST', {
        reason: '重复款已解决，保留唯一有效到账',
      });
      await admin.api(`/finance/${r.id}/reconciliation`, 'POST', {
        reason: '已核对冲正，保留唯一有效款项',
      });
      assert.equal(
        (await db.financeAccount.findUniqueOrThrow({ where: { id: r.id } })).netPaidCents,
        before + 20,
      );
      assert.equal(
        (await db.financeAccount.findUniqueOrThrow({ where: { id: r.id } })).reconciliationRequired,
        false,
      );
    },
  );
  await check(
    'H4: unauthorized arbitrary IDs fail before bulk locks and oversized manager batches fail',
    async () => {
      const ids = Array.from({ length: 10000 }, () => randomUUID()),
        started = Date.now();
      assert.equal(
        (
          await owner.raw(
            '/api/v1/contests/invalid/seating/commit',
            'POST',
            { registrationIds: ids },
            randomUUID(),
          )
        ).status,
        403,
      );
      assert.ok(Date.now() - started < 5000);
      const c = await contest();
      assert.equal(
        (
          await admin.raw(`/api/v1/contests/${c.id}/seating/commit`, 'POST', {
            registrationIds: ids.slice(0, 201),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await admin.raw('/api/v1/admissions/generate', 'POST', {
            registrationIds: ids.slice(0, 101),
          })
        ).status,
        400,
      );
    },
  );
  await check('M1/L50: VIEW cannot read financial audit events or registration PII', async () => {
    const c = await contest(),
      r = await registration(c),
      g = await grant(c.id, ['VIEW']);
    await audit(db, admin.user.id, 'VOUCHER_REVIEW', r.id, { amountCents: 123456 });
    await audit(db, admin.user.id, 'ADMISSION_GENERATE', r.id, { seat: 'secret' });
    const logs = await finance.api(`/admin/audit?contestId=${c.id}&page=1&pageSize=20`);
    assert.ok(
      !logs.items.some((x: any) => ['VOUCHER_REVIEW', 'ADMISSION_GENERATE'].includes(x.action)),
    );
    assert.equal((await finance.raw(`/api/v1/registrations/${r.id}`)).status, 403);
    await admin.api(`/admin/grants/${g.id}`, 'DELETE');
  });
  await check('M2: banning revokes email-only invitations', async () => {
    const invitation = await admin.api('/admin/invitations', 'POST', {
      kind: 'CONTEST_ADMIN',
      targetEmail: `invite-${stamp}@example.test`,
      contestId: (await contest()).id,
      expiresInDays: 1,
    });
    const recipient = new Client();
    await recipient.register({
      email: `invite-${stamp}@example.test`,
      username: `invite_${stamp}`,
      name: '受邀人',
      password,
    });
    assert.equal(
      (await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).targetUserId,
      recipient.user.id,
    );
    const profile = (await recipient.api('/auth/me')).user,
      newEmail = `moved-${stamp}@example.test`;
    await recipient.api('/auth/reauth', 'POST', { password });
    await recipient.api('/auth/profile', 'PUT', {
      version: profile.version,
      name: profile.name,
      profile: profile.profile,
      email: newEmail,
    });
    await recipient.api('/auth/verify', 'POST', { token: await mailboxToken(newEmail) });
    const current = await db.user.findUniqueOrThrow({ where: { id: recipient.user.id } });
    await admin.api(`/admin/users/${current.id}/ban`, 'PUT', {
      version: current.version,
      banned: true,
      reason: '回归测试',
    });
    assert.equal(
      (await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).revoked,
      true,
    );
    const reused = new Client();
    await reused.register({
      email: `invite-${stamp}@example.test`,
      username: `reuse_${stamp}`,
      name: '新邮箱持有人',
      password,
    });
    assert.equal(
      (
        await reused.raw(
          new URL(invitation.url).pathname.replace('/invite/', '/api/v1/invitations/') + '/accept',
          'POST',
          {},
        )
      ).status,
      400,
    );
  });
  await check('M3: mixed-case financial replay rechecks revoked permissions', async () => {
    const c = await contest(100),
      r = await registration(c),
      g = await grant(c.id, ['FINANCE']);
    const v = await voucher(r, 100, `replay-${stamp}`),
      key = randomUUID(),
      body = { decision: 'CONFIRMED' };
    const endpoint = `/api/v1/FINANCE/VOUCHERS/${v.id}/REVIEW/`;
    assert.equal((await finance.raw(endpoint, 'POST', body, key)).status, 201);
    await admin.api(`/admin/grants/${g.id}`, 'DELETE');
    assert.equal((await finance.raw(endpoint, 'POST', body, key)).status, 403);
  });
  await check(
    'M5/M7: webhook management rotates, disables, revokes approval and deletes',
    async () => {
      const c = await contest(),
        hook = await admin.api('/admin/webhooks', 'POST', {
          contestId: c.id,
          url: 'https://8.8.8.8/hook',
        });
      const list = await admin.api(`/admin/webhooks?contestId=${c.id}`);
      assert.equal(list[0].secret, undefined);
      const rotated = await admin.api(`/admin/webhooks/${hook.id}`, 'PUT', {
        version: list[0].version,
        rotateSecret: true,
        enabled: false,
      });
      assert.notEqual(rotated.secret, hook.secret);
      assert.equal((await db.webhook.findUniqueOrThrow({ where: { id: hook.id } })).enabled, false);
      await admin.api(`/admin/webhooks/${hook.id}`, 'DELETE', { version: rotated.version });
      assert.equal(await db.webhook.count({ where: { id: hook.id } }), 0);
      await db.contest.update({
        where: { id: c.id },
        data: { modules: { admissions: true, rooms: false, integrations: false } },
      });
      assert.equal(
        (
          await admin.raw('/api/v1/admin/webhooks', 'POST', {
            contestId: c.id,
            url: 'https://8.8.8.8/hook',
          })
        ).status,
        400,
      );
    },
  );
  await check(
    'M12: SMTP password reuse is bound to endpoint and preserves sender-only edits',
    async () => {
      const initial = await admin.api('/admin/mail');
      try {
        let mail = await admin.api('/admin/mail', 'PUT', {
          ...initial,
          enabled: true,
          host: 'localhost',
          authEnabled: true,
          username: 'fixture',
          password: 'fixture-secret',
        });
        mail = await admin.api('/admin/mail', 'PUT', {
          ...mail,
          password: '',
          fromName: '安全回归',
        });
        assert.equal(
          (await admin.raw('/api/v1/admin/mail', 'PUT', { ...mail, host: '8.8.8.8', password: '' }))
            .status,
          400,
        );
        for (const host of ['169.254.169.254', '::ffff:a9fe:a9fe', 'fd00:ec2::254']) {
          mail = await admin.api('/admin/mail', 'PUT', {
            ...mail,
            host,
            password: 'fixture-secret',
          });
          const probe = await admin.raw('/api/v1/admin/mail/probe', 'POST', {
            version: mail.version,
          });
          assert.equal(probe.status, 400);
          assert.match(await probe.text(), /元数据或链路本地/);
        }
      } finally {
        const current = await admin.api('/admin/mail');
        await admin.api('/admin/mail', 'PUT', {
          ...initial,
          version: current.version,
          password: '',
        });
      }
    },
  );
  await check('M29: database uniqueness and capacity safeguards survive migrations', async () => {
    const indexes = await db.$queryRaw<
      { indexname: string }[]
    >`SELECT indexname FROM pg_indexes WHERE indexname IN ('active_contest_user','active_contest_identifier')`;
    assert.equal(indexes.length, 2);
    const constraints = await db.$queryRaw<
      { conname: string }[]
    >`SELECT conname FROM pg_constraint WHERE conname IN ('ExamRoom_capacity_positive','SeatAssignment_seat_positive')`;
    assert.equal(constraints.length, 2);
  });
  await check(
    'M15/M16: expired preview objects and abandoned spool are removed, active lease remains',
    async () => {
      const old = await db.job.create({
        data: {
          kind: 'PDF_PREVIEW',
          resourceId: owner.user.id,
          dedupeKey: randomUUID(),
          payload: {},
          state: 'SUCCESS',
          createdAt: new Date(Date.now() - 7200000),
          result: await putBlob(`pdf-${randomUUID()}`, Buffer.from('%PDF-test'), 'application/pdf'),
        },
      });
      const lease = randomUUID(),
        active = await db.job.create({
          data: {
            kind: 'PDF_PREVIEW',
            resourceId: owner.user.id,
            dedupeKey: randomUUID(),
            payload: {},
            state: 'RUNNING',
            leaseToken: lease,
            leaseUntil: new Date(Date.now() + 120000),
          },
        });
      const abandoned = path.join(config.spool, `${randomUUID()}-${randomUUID()}`),
        live = path.join(config.spool, `${active.id}-${lease}`);
      await mkdir(abandoned, { recursive: true });
      await mkdir(live, { recursive: true });
      await cleanSpool();
      await assert.rejects(access(abandoned));
      await access(live);
      await retainTemporaryData();
      assert.equal(await db.job.count({ where: { id: old.id } }), 0);
      await assert.rejects(
        access(path.join(config.storage, String((old.result as any).storageKey))),
      );
      await db.job.update({
        where: { id: active.id },
        data: { state: 'CANCELLED', leaseToken: null, leaseUntil: null },
      });
      await cleanSpool();
      const unrelated = path.join(config.storage, 'logo'),
        owned = await putBlob(`orphan-${randomUUID()}`, Buffer.from('owned'), 'text/plain');
      await writeFile(unrelated, 'unrelated shared-directory object');
      await reconcileStorage(Date.now() + 2 * 86400000);
      await access(unrelated);
      await assert.rejects(access(path.join(config.storage, owned.storageKey)));
    },
  );
  await check('M6: token issuer expiry immediately revokes consumer access', async () => {
    const c = await contest(),
      grant = await admin.api('/admin/grants', 'POST', {
        userId: finance.user.id,
        level: 'SYSTEM',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    const issuer = await new Client().login('bob');
    const token = await issuer.api('/admin/tokens', 'POST', {
      name: 'issuer-expiry',
      contestIds: [c.id],
      scopes: ['contests:read'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    assert.equal(
      (await db.apiToken.findUniqueOrThrow({ where: { id: token.id } })).createdBy,
      issuer.user.id,
    );
    const query = () =>
      fetch(`${base}/api/automation/v1/contests`, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
    assert.equal((await query()).status, 200);
    await db.adminGrant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await query()).status, 401);
  });
  await check('M8: integration permission cannot retry admission jobs', async () => {
    const c = await contest(),
      r = await registration(c),
      g = await grant(c.id, ['INTEGRATIONS']);
    const job = await db.job.create({
      data: {
        kind: 'ADMISSION',
        resourceId: r.id,
        dedupeKey: randomUUID(),
        state: 'FAILED',
        attempts: 4,
        payload: {},
      },
    });
    try {
      assert.equal(
        (await finance.raw(`/api/v1/admin/jobs/${job.id}/retry`, 'POST', {})).status,
        403,
      );
      await admin.api(`/admin/grants/${g.id}`, 'DELETE');
      await grant(c.id, ['ADMISSIONS']);
      assert.equal(
        (await finance.raw(`/api/v1/admin/jobs/${job.id}/retry`, 'POST', {})).status,
        201,
      );
    } finally {
      await db.job.deleteMany({ where: { id: job.id } });
    }
  });
  await check(
    'M4: post-deadline evidence loss still permits an explicit review decision',
    async () => {
      let c = await contest();
      c = await admin.api(`/contests/${c.id}`, 'PUT', {
        ...c,
        fields: [
          { key: 'proof', label: '证明', scope: 'REGISTRATION', type: 'file', required: true },
        ],
      });
      let r = await owner.api('/registrations', 'POST', { contestId: c.id });
      const file = await owner.upload(r.id);
      r = await owner.api(`/registrations/${r.id}`, 'PUT', {
        ...r,
        answers: { registration: { proof: file.id } },
      });
      r = await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
      await db.contest.update({
        where: { id: c.id },
        data: { closesAt: new Date(Date.now() - 1000) },
      });
      await owner.api(`/files/${file.id}`, 'DELETE');
      r = await owner.api(`/registrations/${r.id}`);
      assert.equal(r.status, 'CORRECTION');
      assert.equal(r.review, 'CORRECTION');
      assert.equal(
        (
          await admin.raw(`/api/v1/registrations/${r.id}/review`, 'POST', {
            version: r.version,
            decision: 'REJECTED',
            reason: '截止后缺少必需证明',
          })
        ).status,
        201,
      );
    },
  );
  await check('M31: removing a person clears stale seats and supports a fresh plan', async () => {
    let c = await contest(0, { mode: 'TEAM', memberMode: 'MANUAL', maxMembers: 2 });
    c = await admin.api(`/contests/${c.id}`, 'PUT', {
      ...c,
      fields: [],
      modules: { admissions: true, rooms: true, integrations: true },
      seatingMode: 'PERSON',
    });
    await admin.api(`/contests/${c.id}/rooms`, 'POST', { name: 'A101', capacity: 10 });
    let r = await owner.api('/registrations', 'POST', { contestId: c.id });
    r = await owner.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      teamName: '人员座位回归',
      people: [...r.people, { name: '测试队员', email: '', answers: {}, captain: false }],
    });
    r = await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const preview = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', {
      registrationIds: [r.id],
    });
    await admin.api(`/contests/${c.id}/seating/commit`, 'POST', {
      registrationIds: [r.id],
      ...preview,
    });
    assert.equal(await db.seatAssignment.count({ where: { registrationId: r.id } }), 2);
    r = await owner.api(`/registrations/${r.id}`);
    r = await owner.api(`/registrations/${r.id}`, 'PUT', {
      ...r,
      people: r.people.filter((p: any) => p.captain),
    });
    assert.equal(await db.seatAssignment.count({ where: { registrationId: r.id } }), 0);
    assert.ok(
      (await db.contest.findUniqueOrThrow({ where: { id: c.id } })).seatingVersion >
        preview.seatingVersion,
    );
    await owner.api(`/registrations/${r.id}/submit`, 'POST', { version: r.version });
    const next = await admin.api(`/contests/${c.id}/seating/preview`, 'POST', {
      registrationIds: [r.id],
    });
    assert.equal(next.assignments.length, 1);
  });
  await check(
    'M18: compiler scheduling bounds each activity and serves a waiting activity first',
    async () => {
      const first = await registration(await contest()),
        second = await registration(await contest()),
        ids: string[] = [];
      try {
        for (const r of [first, second])
          for (let i = 0; i < 3; i++)
            ids.push(
              (
                await db.job.create({
                  data: {
                    kind: 'ADMISSION',
                    resourceId: r.id,
                    dedupeKey: randomUUID(),
                    payload: {},
                    state: 'PENDING',
                  },
                })
              ).id,
            );
        await db.job
          .create({
            data: {
              kind: 'ADMISSION',
              resourceId: first.id,
              dedupeKey: randomUUID(),
              payload: {},
              state: 'SUCCESS',
              attempts: 1,
            },
          })
          .then((j) => ids.push(j.id));
        const selected = (await pendingPdfJobs()).filter((j) => ids.includes(j.id));
        assert.ok(selected.filter((j) => j.resourceId === first.id).length <= 2);
        assert.ok(selected.filter((j) => j.resourceId === second.id).length <= 2);
        assert.equal(selected[0].resourceId, second.id);
      } finally {
        await db.job.deleteMany({ where: { id: { in: ids } } });
      }
    },
  );
  await check(
    'M32: duplicate active authorization is rejected and a revoke removes legacy duplicates',
    async () => {
      const c = await contest(),
        g = await grant(c.id, ['VIEW']);
      assert.equal(
        (
          await admin.raw('/api/v1/admin/grants', 'POST', {
            userId: finance.user.id,
            level: 'CONTEST',
            contestId: c.id,
            permissions: ['VIEW'],
          })
        ).status,
        400,
      );
      await db.adminGrant.create({
        data: {
          userId: finance.user.id,
          level: 'CONTEST',
          contestId: c.id,
          permissions: ['FINANCE'],
          grantedBy: admin.user.id,
        },
      });
      await admin.api(`/admin/grants/${g.id}`, 'DELETE');
      assert.equal(
        await db.adminGrant.count({
          where: { userId: finance.user.id, contestId: c.id, revokedAt: null },
        }),
        0,
      );
    },
  );
} finally {
  await db.contest.updateMany({
    where: { id: { in: contestIds } },
    data: { archived: true, published: false },
  });
  await db.adminGrant.updateMany({
    where: { contestId: { in: contestIds }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/audit-20261022.json',
    JSON.stringify(
      { success: checks.length === 17 && !failures.length, checks, failures },
      null,
      2,
    ),
  );
  await redis.quit();
  await db.$disconnect();
}
assert.equal(checks.length, 17, failures.join('\n'));
assert.deepEqual(failures, []);
