import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client } from './client.js';
import { policySchema } from '../../packages/contracts/src/index.js';
import { db } from '../../apps/server/src/db.js';
import { redis } from '../../apps/server/src/auth.js';
const checks: string[] = [];
try {
  await redis.del('rate:login:127.0.0.1', 'rate:login:::ffff:127.0.0.1');
  const admin = await new Client().login('admin'),
    user = await new Client().login('alice'),
    manager = await new Client().login('manager');
  const make = async (published: boolean) =>
    admin.api('/contests', 'POST', {
      title: '大屏验收 ' + Date.now(),
      season: '统计',
      description: '虚构数据',
      published,
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      opensAt: new Date(Date.now() - 10000).toISOString(),
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      fields: [],
      policy: policySchema.parse({
        manualReview: false,
        coachMode: 'DISABLED',
        allowUnofficial: true,
      }),
    });
  const visible = await make(true),
    hidden = await make(false);
  const draft = await user.api('/registrations', 'POST', { contestId: visible.id });
  assert.equal((await user.api('/overview?contestId=' + visible.id)).totals.submitted, 0);
  const submitted = await user.api(`/registrations/${draft.id}/submit`, 'POST', {
    version: draft.version,
  });
  let data = await user.api('/overview?contestId=' + visible.id);
  assert.equal(data.totals.submitted, 1);
  assert.equal(data.totals.active, 1);
  assert.equal(data.totals.participants, 1);
  assert.equal(data.totals.approved, 1);
  assert.equal(data.totals.eligible, 1);
  const all = await admin.api('/overview');
  for (const key of ['submitted', 'active', 'participants', 'approved', 'eligible'])
    assert.equal(
      all.totals[key],
      all.activities.reduce((sum: number, row: any) => sum + row[key], 0),
    );
  assert.ok(!JSON.stringify(data).includes(user.user.email));
  checks.push(
    '实际提交、参与人次、审核和资格统计准确；总体与各活动合计一致，草稿不计入且不返回个人资料',
  );
  assert.equal((await new Client().raw('/api/v1/overview')).status, 401);
  assert.equal((await user.raw('/api/v1/overview?contestId=' + hidden.id)).status, 403);
  assert.ok(!(await user.api('/overview')).activities.some((row: any) => row.id === hidden.id));
  const grant = await admin.api('/admin/grants', 'POST', {
    userId: manager.user.id,
    level: 'CONTEST',
    contestId: hidden.id,
    permissions: ['VIEW'],
  });
  assert.equal((await manager.api('/overview?contestId=' + hidden.id)).activities[0].id, hidden.id);
  await admin.api(`/admin/grants/${grant.id}`, 'DELETE');
  assert.equal((await manager.raw('/api/v1/overview?contestId=' + hidden.id)).status, 403);
  checks.push('匿名和普通用户不能查看隐藏活动，授权管理员可见且撤权即时生效');
  await user.api(`/registrations/${submitted.id}/cancel`, 'POST', { version: submitted.version });
  data = await user.api('/overview?contestId=' + visible.id);
  assert.equal(data.totals.submitted, 1);
  assert.equal(data.totals.active, 0);
  assert.equal(data.totals.participants, 0);
  assert.equal(data.totals.cancelled, 1);
  await db.contest.update({ where: { id: visible.id }, data: { archived: true } });
  assert.ok(!(await admin.api('/overview')).activities.some((row: any) => row.id === visible.id));
  checks.push('取消保留累计提交但移除当前人数，归档活动不再参与统计');
  for (const message of checks) console.log('PASS ' + message);
} finally {
  await writeFile('.runtime/reports/overview.json', JSON.stringify({ checks }, null, 2));
  await redis.quit();
  await db.$disconnect();
}
