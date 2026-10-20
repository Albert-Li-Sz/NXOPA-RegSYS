import { randomUUID } from 'node:crypto';
import { db, json } from '../../apps/server/src/db.js';
import { policySchema } from '../../packages/contracts/src/index.js';

export async function exportFixture(ownerId: string, mode: 'TEAM' | 'INDIVIDUAL' = 'TEAM') {
  const id = randomUUID();
  const contest = await db.contest.create({
    data: {
      id,
      title: `平台导出验收 ${id.slice(0, 8)}`,
      season: '验收',
      description: '仅用于本地验收',
      startsAt: new Date(Date.now() + 86400000),
      opensAt: new Date(Date.now() - 3600000),
      closesAt: new Date(Date.now() + 3600000),
      published: true,
      modules: { admissions: false, rooms: false, integrations: true },
      policy: json(policySchema.parse({ mode, manualReview: false, coachMode: 'DISABLED' })),
    },
  });
  const rows = [];
  for (let i = 0; i < 4; i++)
    rows.push(
      await db.registration.create({
        data: {
          contestId: id,
          ownerId,
          number: i + 1,
          formVersion: 1,
          teamName: i === 0 ? 'NULL' : i === 1 ? '=SUM(1,2)' : `验收队 ${i}`,
          participationType: i === 1 ? 'UNOFFICIAL' : 'OFFICIAL',
          organization: { name: '测试大学', shortName: 'TEST', country: 'CHN', icpcId: '' },
          status: i === 2 ? 'DRAFT' : 'SUBMITTED',
          eligible: i < 2,
          review: 'APPROVED',
          people: {
            create: [
              {
                contestId: id,
                name: i === 0 ? 'NULL' : '同名选手',
                email: 'fixture@example.test',
                captain: true,
              },
            ],
          },
        },
      }),
    );
  return {
    contest,
    rows,
    async cleanup() {
      await db.adminGrant.deleteMany({ where: { contestId: id } });
      await db.registration.deleteMany({ where: { contestId: id } });
      await db.contest.delete({ where: { id } });
    },
  };
}
