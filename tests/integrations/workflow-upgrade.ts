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
  rollback = `${database}_rollback`;
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
  sql('postgres', `CREATE DATABASE "${database}"; CREATE DATABASE "${rollback}";`);
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
    INSERT INTO "PaymentVoucher" (id,"registrationId","amountCents",channel,payer,"paidAt","attachmentId",status) VALUES ('${randomUUID()}','${paid}',5000,'TEST','付款人',NOW(),'${receipt}','CONFIRMED');
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
  run('pnpm', ['db:migrate'], undefined, isolated);
  Object.assign(process.env, isolated);
  const { db } = await import('../../apps/server/src/db.js');
  const { migrateCancelledRegistrations } =
    await import('../../apps/server/src/registration-removal.js');
  try {
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
    `DROP DATABASE IF EXISTS "${database}" WITH (FORCE); DROP DATABASE IF EXISTS "${rollback}" WITH (FORCE);`,
  );
}
