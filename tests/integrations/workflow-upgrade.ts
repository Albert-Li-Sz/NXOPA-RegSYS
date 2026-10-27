import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as dotenv } from 'dotenv';
dotenv({ path: '.env', quiet: true });
if (process.env.NODE_ENV === 'production') throw new Error('Development fixtures only');
const root = process.cwd(),
  stage = path.join(root, '.runtime', `workflow-upgrade-${Date.now()}`);
const pgContainer = process.env.WORKFLOW_UPGRADE_PG_CONTAINER || 'contest-center-dev-postgres-1';
const originalUrl = process.env.DATABASE_URL!;
const target = new URL(originalUrl),
  database = `workflow_upgrade_${Date.now()}`,
  rollback = `${database}_rollback`,
  references = `${database}_references`;
const checks: string[] = [];
function run(cmd: string, args: string[], input?: string | Buffer, env = process.env) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status)
    throw new Error(
      `${cmd} failed: ${(r.stderr || r.stdout).replaceAll(target.password, '<REDACTED>').slice(-1800)}`,
    );
  return r.stdout.trim();
}
const sql = (name: string, statement: string) =>
  run(
    'docker',
    [
      'exec',
      '-i',
      pgContainer,
      'psql',
      '-X',
      '-U',
      target.username,
      '-d',
      name,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    statement,
  );
const pass = (s: string) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
await mkdir(path.join(stage, 'migrations'), { recursive: true });
try {
  sql(
    'postgres',
    `CREATE DATABASE "${database}"; CREATE DATABASE "${rollback}"; CREATE DATABASE "${references}";`,
  );
  for (const name of (await readdir('apps/server/prisma/migrations')).filter(
    (name) => /^\d/.test(name) && name < '202610150001_activity_workflows',
  ))
    await cp(
      path.join(root, 'apps/server/prisma/migrations', name),
      path.join(stage, 'migrations', name),
      { recursive: true },
    );
  await writeFile(
    path.join(stage, 'schema.prisma'),
    'datasource db {\n provider = "postgresql"\n}\n',
  );
  await writeFile(
    path.join(stage, 'prisma.config.ts'),
    `export default {schema:${JSON.stringify(path.join(stage, 'schema.prisma'))},migrations:{path:${JSON.stringify(path.join(stage, 'migrations'))}},datasource:{url:process.env.DATABASE_URL}};\n`,
  );
  target.pathname = `/${database}`;
  const isolated = {
    ...process.env,
    DATABASE_URL: target.toString(),
    STORAGE_DIR: path.join(stage, 'files'),
    LATEX_SPOOL: path.join(stage, 'latex'),
  };
  run(
    'pnpm',
    [
      '--filter',
      '@contest-center/server',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      path.join(stage, 'prisma.config.ts'),
    ],
    undefined,
    isolated,
  );
  const [
    owner,
    contest,
    active,
    paid,
    free,
    receipt,
    privateFile,
    person,
    template,
    doc,
    instance,
    binding,
    mapping,
    refund,
    invoice,
  ] = Array.from({ length: 15 }, randomUUID);
  sql(
    database,
    `
    INSERT INTO "User" (id,email,username,name,verified) VALUES ('${owner}','upgrade@example.test','workflow_upgrade','迁移测试用户',true);
    INSERT INTO "Contest" (id,title,season,description,"startsAt","opensAt","closesAt",policy) VALUES ('${contest}','v0.4.0 升级测试','验收','测试',NOW()+interval '2 days',NOW()-interval '1 day',NOW()+interval '1 day','{}');
    INSERT INTO "Registration" (id,"contestId","ownerId",status,"formVersion","submittedAt",number,"feeCents","netPaidCents",snapshot,"updatedAt") VALUES
    ('${active}','${contest}','${owner}','DRAFT',1,NULL,NULL,0,0,'{}',NOW()),
    ('${paid}','${contest}','${owner}','CANCEL_REQUESTED',1,NOW(),1,5000,5000,'{"private":"remove-me"}',NOW()),
    ('${free}','${contest}','${owner}','CANCELLED',1,NOW(),2,0,0,'{}',NOW());
    INSERT INTO "RegistrationPerson" (id,"registrationId","contestId",name,answers) VALUES ('${person}','${paid}','${contest}','不保留的报名姓名','{"private":"remove-me"}');
    INSERT INTO "Attachment" (id,"ownerId","registrationId",name,mime,size,"storageKey",sha256) VALUES ('${receipt}','${owner}','${paid}','付款凭证.txt','text/plain',5,'upgrade-receipt',''),('${privateFile}','${owner}','${paid}','报名专属.txt','text/plain',5,'upgrade-private','');
    INSERT INTO "PaymentVoucher" (id,"registrationId","amountCents",channel,payer,"paidAt","attachmentId",status) VALUES ('${randomUUID()}','${paid}',5000,'TEST','付款人',NOW(),'${receipt}','CONFIRMED'), ('${randomUUID()}','${paid}',5000,'TEST','重复在途',NOW(),'${receipt}','PENDING');
    INSERT INTO "LedgerEntry" (id,"registrationId","contestId",kind,"amountCents","sourceId","actorId",note) VALUES ('${randomUUID()}','${paid}','${contest}','PAYMENT',5000,'upgrade-payment','${owner}','实际到账');
    INSERT INTO "Refund" (id,"registrationId","amountCents",reason) VALUES ('${refund}','${paid}',1000,'待退款');
    INSERT INTO "InvoiceRequest" (id,"registrationId","amountCents",title,"taxId",email) VALUES ('${invoice}','${paid}',4000,'测试个人','','upgrade@example.test');
    INSERT INTO "RegistrationRevision" (id,"registrationId",version,"actorId",snapshot,reason) VALUES ('${randomUUID()}','${paid}',1,'${owner}','{"private":"remove-me"}','SUBMIT');
    INSERT INTO "AdmissionTemplate" (id,name,source,version) VALUES ('${template}','旧模板','old-template',1);
    INSERT INTO "AdmissionDocument" (id,"registrationId",number,location,"registrationVersion","templateId","templateVersion",state,"storageKey") VALUES ('${doc}','${paid}','OLD-001','旧考点',1,'${template}',1,'READY','upgrade-pdf');
    INSERT INTO "PlatformInstance" (id,name,type,"baseUrl",credentials) VALUES ('${instance}','升级占位平台','DOMJUDGE','https://fixture.invalid','placeholder');
    INSERT INTO "PlatformBinding" (id,"contestId","instanceId","remoteContestId") VALUES ('${binding}','${contest}','${instance}','upgrade');
    INSERT INTO "AccountMapping" (id,"registrationId","bindingId",username,credential,"remoteUserId","remoteTeamId",state,"updatedAt") VALUES ('${mapping}','${paid}','${binding}','upgrade','placeholder','remote-user','remote-team','VERIFIED',NOW());
    INSERT INTO "Job" (id,kind,"resourceId","dedupeKey",payload,"updatedAt") VALUES ('${randomUUID()}','ADMISSION','${paid}','upgrade-old-job','{"private":"remove-me","documentId":"${doc}"}',NOW());
    INSERT INTO "Job" (id,kind,"resourceId","dedupeKey",payload,"updatedAt") VALUES ('${randomUUID()}','SYNC','${active}','upgrade-old-sync','{}',NOW());
    INSERT INTO "OutboxEvent" (id,type,"resourceId",payload) VALUES ('${randomUUID()}','SYNC_REQUEST','${active}','{}');
    INSERT INTO "Invitation" (id,"tokenHash",kind,"registrationId","inviterId","expiresAt") VALUES ('${randomUUID()}','upgrade-token','MEMBER','${paid}','${owner}',NOW()+interval '1 day');
  `,
  );
  const before = sql(
    database,
    `SELECT json_build_object('balance',(SELECT SUM("netPaidCents") FROM "Registration"),'vouchers',(SELECT count(*) FROM "PaymentVoucher"),'ledger',(SELECT count(*) FROM "LedgerEntry"),'refunds',(SELECT count(*) FROM "Refund"),'invoices',(SELECT count(*) FROM "InvoiceRequest"))`,
  );
  const backup = spawnSync(
    'docker',
    ['exec', pgContainer, 'pg_dump', '-U', target.username, '-d', database, '-Fc'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(backup.status, 0);
  assert.ok(backup.stdout.length > 1000);
  await writeFile(path.join(stage, 'before-v0.4.dump'), backup.stdout, { mode: 0o600 });
  pass('建立真实 v0.4.0 表结构、取消／未取消报名、财务及后台任务，并备份');
  // Stop immediately before room codes are introduced, with real assigned legacy rooms.
  for (const name of (await readdir('apps/server/prisma/migrations')).filter(
    (name) => name >= '202610150001_activity_workflows' && name < '202610230001_exam_room_code',
  ))
    await cp(
      path.join(root, 'apps/server/prisma/migrations', name),
      path.join(stage, 'migrations', name),
      { recursive: true },
    );
  run(
    'pnpm',
    [
      '--filter',
      '@contest-center/server',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      path.join(stage, 'prisma.config.ts'),
    ],
    undefined,
    isolated,
  );
  const legacyRoom = randomUUID();
  sql(
    database,
    `
    INSERT INTO "ExamRoom" (id,"contestId",name,capacity) VALUES ('${legacyRoom}','${contest}','A',30),('${randomUUID()}','${contest}','B',30);
    INSERT INTO "SeatAssignment" (id,"registrationId","roomId","unitKey",seat) VALUES ('${randomUUID()}','${active}','${legacyRoom}','registration',1);
  `,
  );
  run('pnpm', ['db:migrate'], undefined, isolated);
  Object.assign(process.env, isolated);
  const { db } = await import('../../apps/server/src/db.js');
  const { migrateCancelledRegistrations } =
    await import('../../apps/server/src/registration-removal.js');
  try {
    const room = await db.examRoom.findUniqueOrThrow({ where: { id: legacyRoom } });
    assert.equal(room.code, null);
    assert.equal(room.name, 'A');
    assert.equal(room.capacity, 30);
    assert.equal(await db.examRoom.count({ where: { contestId: contest, code: null } }), 2);
    assert.equal(
      (await db.seatAssignment.findFirstOrThrow({ where: { roomId: legacyRoom } })).seat,
      1,
    );
    pass('旧考场编号迁移为空且不从名称推测，多个空编号与原座位完整保留');
    await migrateCancelledRegistrations();
    await migrateCancelledRegistrations();
    assert.equal(await db.registration.count(), 1);
    assert.equal(
      (await db.registration.findUniqueOrThrow({ where: { id: active } })).examSiteId,
      null,
    );
    assert.equal(await db.examSite.count(), 0);
    assert.equal(
      (await db.registration.findUniqueOrThrow({ where: { id: active } })).status,
      'DRAFT',
    );
    const account = await db.financeAccount.findUniqueOrThrow({ where: { id: paid } });
    assert.equal(account.netPaidCents, 5000);
    assert.ok(account.cancelledAt);
    assert.equal(account.reconciliationRequired, true);
    const proof = await db.paymentProofClaim.findUniqueOrThrow({
      where: { attachmentId: receipt },
      include: { voucher: true },
    });
    assert.equal(proof.voucher.status, 'CONFIRMED');
    assert.equal(
      await db.auditEvent.count({
        where: { resourceId: paid, action: 'VOUCHER_DUPLICATE_HISTORY' },
      }),
      1,
    );
    assert.equal(
      (await db.platformInstance.findUniqueOrThrow({ where: { id: instance } })).enabled,
      false,
    );
    assert.equal(
      (await db.platformInstance.findUniqueOrThrow({ where: { id: instance } })).credentials,
      '',
    );
    assert.equal(await db.job.count({ where: { kind: 'SYNC', state: 'CANCELLED' } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { type: 'SYNC_REQUEST' } }), 0);
    const after = sql(
      database,
      `SELECT json_build_object('balance',(SELECT SUM("netPaidCents") FROM "FinanceAccount"),'vouchers',(SELECT count(*) FROM "PaymentVoucher"),'ledger',(SELECT count(*) FROM "LedgerEntry"),'refunds',(SELECT count(*) FROM "Refund"),'invoices',(SELECT count(*) FROM "InvoiceRequest"))`,
    );
    assert.deepEqual(JSON.parse(after), JSON.parse(before));
    assert.ok(await db.attachment.findUnique({ where: { id: receipt } }));
    assert.equal(await db.attachment.count({ where: { id: privateFile, deletedAt: null } }), 0);
    assert.equal(await db.registrationRevision.count(), 0);
    assert.equal(await db.registrationPerson.count(), 0);
    assert.equal(await db.admissionDocument.count(), 0);
    assert.equal(await db.accountMapping.count(), 0);
    assert.equal(await db.invitation.count(), 0);
    assert.equal(
      await db.remoteRevocation.count({ where: { remoteUserId: 'remote-user', state: 'PENDING' } }),
      1,
    );
    assert.equal(await db.job.count({ where: { resourceId: paid, state: 'CANCELLED' } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { type: 'MAIL' } }), 0);
    pass('迁移清除历史取消报名及资料副本，财务余额与四类单据逐项一致，撤权待办保留');
  } finally {
    await db.$disconnect();
    process.env.DATABASE_URL = originalUrl;
  }

  // The staged migration directory still represents the schema before the new
  // partial indexes. Verify real reversed payments survive the upgrade intact.
  const referenceUrl = new URL(originalUrl);
  referenceUrl.pathname = `/${references}`;
  const referenceEnv = { ...isolated, DATABASE_URL: referenceUrl.toString() };
  run(
    'pnpm',
    [
      '--filter',
      '@contest-center/server',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      path.join(stage, 'prisma.config.ts'),
    ],
    undefined,
    referenceEnv,
  );
  const [
    referenceContest,
    accountId,
    attachmentId,
    voucherId,
    paymentId,
    reversalId,
    admissionRegistration,
    admissionTemplate,
    invalidAdmission,
    validAdmission,
  ] = Array.from({ length: 10 }, randomUUID);
  sql(
    references,
    `
    INSERT INTO "Contest" (id,title,season,description,"startsAt","opensAt","closesAt",policy)
      VALUES ('${referenceContest}','流水号升级','验收','测试',NOW(),NOW(),NOW(),'{}');
    INSERT INTO "FinanceAccount" (id,"contestId","ownerId","policySnapshot")
      VALUES ('${accountId}','${referenceContest}','${owner}','{}');
    INSERT INTO "Attachment" (id,"ownerId",name,mime,size,"storageKey",sha256)
      VALUES ('${attachmentId}','${owner}','proof.txt','text/plain',5,'reference-upgrade','${'a'.repeat(64)}');
    INSERT INTO "PaymentVoucher" (id,"registrationId","amountCents",channel,reference,payer,"paidAt","attachmentId",status,"createdBy")
      VALUES ('${voucherId}','${accountId}',1000,'TEST','legacy-001','付款人',NOW(),'${attachmentId}','CONFIRMED','${owner}');
    INSERT INTO "LedgerEntry" (id,"registrationId","contestId",kind,"amountCents","sourceId","channelReference","normalizedReference","actorId",note) VALUES
      ('${paymentId}','${accountId}','${referenceContest}','PAYMENT',1000,'voucher:${voucherId}','TEST:legacy-001','payment:legacy-001','${owner}','原收款'),
      ('${reversalId}','${accountId}','${referenceContest}','REVERSAL',-1000,'reverse:${paymentId}',NULL,NULL,'${owner}','历史冲正');
    INSERT INTO "PaymentProofClaim" ("attachmentId","voucherId","registrationId","proofSha256")
      VALUES ('${attachmentId}','${voucherId}','${accountId}','${'a'.repeat(64)}');
    INSERT INTO "Registration" (id,"contestId","ownerId","formVersion",version,"updatedAt")
      VALUES ('${admissionRegistration}','${referenceContest}','${owner}',1,3,NOW());
    INSERT INTO "AdmissionTemplate" (id,name,source,version) VALUES ('${admissionTemplate}','迁移模板','test-template',1);
    INSERT INTO "AdmissionDocument" (id,"registrationId",number,location,"registrationVersion","templateId","templateVersion",state,"releasedAt") VALUES
      ('${invalidAdmission}','${admissionRegistration}','INVALID-OLD','旧版',2,'${admissionTemplate}',1,'RELEASED',NOW()),
      ('${validAdmission}','${admissionRegistration}','VALID-CURRENT','当前',3,'${admissionTemplate}',1,'RELEASED',NOW());
  `,
  );
  run('pnpm', ['db:migrate'], undefined, referenceEnv);
  assert.equal(
    sql(
      references,
      `SELECT payment."reversedAt"=reversal."createdAt" AND payment."channelReference"='TEST:legacy-001' AND payment."normalizedReference"='payment:legacy-001' AND payment."amountCents"=1000 FROM "LedgerEntry" payment JOIN "LedgerEntry" reversal ON reversal.id='${reversalId}' WHERE payment.id='${paymentId}'`,
    ),
    't',
  );
  assert.equal(sql(references, 'SELECT count(*) FROM "PaymentProofClaim"'), '0');
  assert.equal(
    sql(
      references,
      `SELECT state='STALE' AND "releasedAt" IS NULL AND version=2 FROM "AdmissionDocument" WHERE id='${invalidAdmission}'`,
    ),
    't',
  );
  assert.equal(
    sql(
      references,
      `SELECT state='RELEASED' AND "releasedAt" IS NOT NULL AND version=1 FROM "AdmissionDocument" WHERE id='${validAdmission}'`,
    ),
    't',
  );
  assert.equal(
    sql(references, `SELECT status FROM "PaymentVoucher" WHERE id='${voucherId}'`),
    'CONFIRMED',
  );
  const insert = (channel: string, normalized: string) =>
    sql(
      references,
      `INSERT INTO "LedgerEntry" (id,"registrationId","contestId",kind,"amountCents","sourceId","channelReference","normalizedReference","actorId",note) VALUES ('${randomUUID()}','${accountId}','${referenceContest}','PAYMENT',1000,'${randomUUID()}','${channel}','${normalized}','${owner}','更正收款')`,
    );
  insert('TEST:legacy-001', 'payment:legacy-001');
  assert.throws(() => insert('OTHER:legacy-001', 'payment:legacy-001'), /normalizedReference_key/);
  assert.throws(() => insert('TEST:legacy-001', 'payment:other'), /channelReference_key/);
  run('pnpm', ['db:migrate'], undefined, referenceEnv);
  assert.equal(sql(references, 'SELECT count(*) FROM "LedgerEntry"'), '3');
  pass('历史冲正迁移保留账簿及凭证，释放流水号与凭证占用，并继续阻止有效收款重复入账');
  pass('历史版本不符的准考证明确失效，当前有效证件保持已发放');

  run(
    'docker',
    [
      'exec',
      '-i',
      pgContainer,
      'pg_restore',
      '-U',
      target.username,
      '-d',
      rollback,
      '--exit-on-error',
    ],
    backup.stdout,
  );
  assert.equal(sql(rollback, 'SELECT count(*) FROM "Registration"'), '3');
  assert.equal(
    sql(rollback, `SELECT "netPaidCents" FROM "Registration" WHERE id='${paid}'`),
    '5000',
  );
  pass('升级前备份可恢复旧报名与账目，验证回退需要完整备份');
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/workflow-upgrade.json',
    JSON.stringify({ success: true, checks }, null, 2),
  );
} finally {
  process.env.DATABASE_URL = originalUrl;
  sql(
    'postgres',
    `DROP DATABASE IF EXISTS "${database}" WITH (FORCE); DROP DATABASE IF EXISTS "${rollback}" WITH (FORCE); DROP DATABASE IF EXISTS "${references}" WITH (FORCE);`,
  );
}
