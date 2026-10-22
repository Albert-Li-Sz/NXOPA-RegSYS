import { BadRequestException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  organizationSchema,
  policySchema,
  platformExportSchema,
  type Principal,
} from '@contest-center/contracts';
import { db, audit } from './db.js';
import { decrypt, encrypt, requireManager, sha } from './security.js';
import { modulesFor } from './workflow.js';
import { withExportBudget } from './export-budget.js';

const jsonFile = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

// Generates a local snapshot only. Never contacts a judging platform.
export async function platformExport(u: Principal, contestId: string, body: unknown) {
  requireManager(u, contestId, 'INTEGRATIONS');
  const options = platformExportSchema.parse(body);
  const prefix = `cc_${contestId.replaceAll('-', '')}`;
  const official = options.officialGroupId ?? `${prefix}_official`;
  const unofficial = options.unofficialGroupId ?? `${prefix}_unofficial`;
  if (options.platform === 'DOMJUDGE' && official === unofficial)
    throw new BadRequestException('正式与非正式分组编号必须不同');
  return withExportBudget(u.id, contestId, async () => {
    const tx = db;
    const started = Date.now();
    const contest = await tx.contest.findUniqueOrThrow({ where: { id: contestId } });
    if (!modulesFor(contest).integrations)
      throw new BadRequestException('此活动未启用平台文件导出');
    const where = {
      contestId,
      eligible: true,
      status: { notIn: ['DRAFT', 'CANCELLED', 'CANCEL_REQUESTED'] },
      ...(!options.includeUnofficial ? { participationType: 'OFFICIAL' } : {}),
    };
    const candidates = await tx.registration.findMany({
      where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 10001,
    });
    if (candidates.length > 10000) throw new BadRequestException('单次最多导出 10000 条报名');
    if (!candidates.length) throw new BadRequestException('暂无符合条件的合格报名可导出');
    const load = (ids: string[]) =>
      tx.registration.findMany({
        where: { ...where, id: { in: ids } },
        select: {
          id: true,
          number: true,
          version: true,
          teamName: true,
          teamEnglishName: true,
          participationType: true,
          organization: true,
          policySnapshot: true,
          answers: true,
          people: {
            where: { active: true },
            select: { id: true, name: true, captain: true },
            orderBy: [{ captain: 'desc' }, { id: 'asc' }],
          },
          coaches: { select: { user: { select: { name: true } } }, orderBy: { id: 'asc' } },
          seats: {
            select: { seat: true, room: { select: { name: true, location: true } } },
            orderBy: [{ roomId: 'asc' }, { seat: 'asc' }],
          },
        },
        orderBy: [{ number: 'asc' }, { id: 'asc' }],
      });
    const rows: Awaited<ReturnType<typeof load>> = [];
    let bytes = 0;
    for (let index = 0; index < candidates.length; index += 10) {
      if (Date.now() - started > 120000) throw new BadRequestException('导出超时，请缩小范围');
      const batch = await load(candidates.slice(index, index + 10).map((row) => row.id));
      for (const row of batch) {
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > 50 * 1024 * 1024) throw new BadRequestException('导出资料超过 50 MB');
        rows.push(row);
      }
    }
    rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id));
    if (!rows.length) throw new BadRequestException('暂无符合条件的合格报名可导出');
    const teams: Record<string, unknown>[] = [],
      accounts: Record<string, unknown>[] = [];
    const organizations = new Map<string, Record<string, unknown>>();
    const credentials: unknown[][] = [
      ['报名编号', '队名／姓名', '用户名', '密码', '座位', '参赛性质'],
    ];
    const savedAccounts = await tx.platformExportAccount.findMany({
      where: { registrationId: { in: rows.map((r) => r.id) }, platform: options.platform },
    });
    const accountMap = new Map(savedAccounts.map((a) => [a.registrationId, a]));
    const newAccounts: typeof savedAccounts = [];
    const seats = new Set<string>();
    for (const r of rows) {
      const individual =
        policySchema.parse(r.policySnapshot ?? contest.policy).mode === 'INDIVIDUAL';
      const name = (individual ? r.people[0]?.name : r.teamName)?.trim();
      if (!name || !r.people.length)
        throw new BadRequestException(`报名 ${r.number ?? r.id} 缺少队名或成员姓名`);
      const info = organizationSchema.safeParse(r.organization);
      if (!info.success)
        throw new BadRequestException(
          `报名 ${r.number ?? r.id} 缺少完整代表单位，请补正后重新审核`,
        );
      if (r.seats.length > 1)
        throw new BadRequestException(
          `报名 ${r.number ?? r.id} 有多个成员座位，无法映射到一个平台队伍座位`,
        );
      const fields = (r.answers as { registration?: Record<string, unknown> }).registration ?? {};
      const assigned = r.seats[0];
      const rawSeat = assigned
        ? `${assigned.room.name}-${assigned.seat}`
        : String(fields.team_label ?? '').trim();
      const seat = `${prefix}-${rawSeat || r.number || r.id}`;
      if (seats.has(seat)) throw new BadRequestException(`座位重复：${rawSeat}，请调整后重新导出`);
      if (options.platform === 'HYDRO' && /[,\r\n]/.test(seat))
        throw new BadRequestException('Hydro 座位不能包含逗号或换行，请调整队伍编号／考场名称');
      seats.add(seat);
      let account = accountMap.get(r.id);
      if (!account) {
        const identity = sha(`${contestId}:${r.id}:${options.platform}`).slice(0, 20);
        // Keep human names visible even on scoreboards that ignore displayName.
        const readable =
          name
            .normalize('NFKC')
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
            .slice(0, 6) || 'team';
        account = {
          id: randomUUID(),
          registrationId: r.id,
          platform: options.platform,
          username: options.platform === 'HYDRO' ? `${readable}_${identity}` : `cc_${identity}`,
          credential: encrypt(`P${randomBytes(18).toString('base64url')}`),
          createdAt: new Date(),
        };
        accountMap.set(r.id, account);
        newAccounts.push(account);
      }
      const password = decrypt(account.credential);
      const unrank =
        options.importMode === 'FORCE_UNOFFICIAL' || r.participationType === 'UNOFFICIAL';
      credentials.push([
        r.number,
        name,
        account.username,
        password,
        seat,
        unrank ? '非正式' : '正式',
      ]);
      if (options.platform === 'HYDRO') {
        teams.push({
          id: account.username,
          name: account.username,
          displayName: name,
          password,
          school: info.data.name,
          members: r.people.map((p) => p.name),
          coach: r.coaches.map((c) => c.user.name).join('、'),
          seat,
          rank: !unrank,
        });
      } else {
        const orgId = `cc_org_${sha(`${info.data.country}:${info.data.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()}`).slice(0, 24)}`;
        const organization = {
          id: orgId,
          name: info.data.shortName,
          formal_name: info.data.name,
          country: info.data.country,
          ...(info.data.icpcId ? { icpc_id: info.data.icpcId } : {}),
        };
        const prior = organizations.get(orgId);
        if (prior && jsonFile(prior) !== jsonFile(organization))
          throw new BadRequestException(
            `代表单位 ${info.data.name} 的简称或 ICPC 编号不一致，请统一后导出`,
          );
        organizations.set(orgId, organization);
        teams.push({
          id: account.username,
          label: seat,
          name,
          display_name: name,
          group_ids: [unrank ? unofficial : official],
          organization_id: orgId,
          members: [r.teamEnglishName, ...r.people.map((p) => p.name)].filter(Boolean).join(' / '),
          ...(fields.team_icpc_id ? { icpc_id: String(fields.team_icpc_id) } : {}),
          location: {
            description: assigned?.room.location || String(fields.team_location ?? ''),
          },
        });
        accounts.push({
          id: account.username,
          username: account.username,
          password,
          type: 'team',
          team_id: account.username,
          name,
        });
      }
    }
    for (let i = 0; i < newAccounts.length; i += 1000)
      await tx.platformExportAccount.createMany({ data: newAccounts.slice(i, i + 1000) });
    const files: Record<string, string> = { 'teams.json': jsonFile(teams) };
    if (options.platform === 'DOMJUDGE')
      Object.assign(files, {
        'organizations.json': jsonFile([...organizations.values()]),
        'groups.json': jsonFile([
          { id: official, name: '正式参赛', sortorder: 0 },
          { id: unofficial, name: '非正式参赛', sortorder: 1 },
        ]),
        'accounts.json': jsonFile(accounts),
      });
    files['credentials.csv'] =
      '\uFEFF' + credentials.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    files['README.txt'] =
      options.platform === 'HYDRO'
        ? 'Hydro 最新版 + @hydrooj/onsite-toolkit：\n启用 extraFields、contestMode；需要 IP 登录时再启用 ipLogin。\n以 Hydro 运行用户执行：\nhydrooj cli system onsiteImport /绝对路径/teams.json 比赛ObjectId webp 域ID\n默认域填 system；多个比赛ID用逗号连接，逗号后不加空项。\nname 是唯一登录名，displayName 是队名／姓名；部分外榜只显示 name，赛前核对榜单。\n座位带活动前缀，避免跨赛冲突。重复导出账号密码稳定；重新导入会将远端密码重置成文件中的密码。\nIP 未自动填写；需要时用无表头的“seat,ip”CSV执行 setIpLogin。\n'
        : 'DOMjudge 9.x：后台 Import / export → Import JSON / YAML，依次导入 groups.json、organizations.json、teams.json、accounts.json。\n用户导入类型选 accounts，不是 users；account.type 固定为 team，team_id 对应队伍外部 id。\n正式和非正式组使用不同 sortorder，在目标比赛配置中允许对应分组参赛。\n重复导入队伍按外部ID更新；已有用户可能跳过或拒绝更新，改名／密码请在远端后台核对。\n队伍编号带活动前缀，DOMjudge 要求其全局唯一。\n';
    files['README.txt'] +=
      '\n本包只包含本次取得参赛资格的报名，不会自动导入或删除远端账号。资格撤销／报名删除后，请在远端手动处理。\ncredentials.csv 含明文比赛密码，请妥善分发和销毁。本站密码与比赛密码独立。\n完整教程：https://albert-li-sz.github.io/NXOPA-RegSYS/\n';
    await audit(tx, u.id, 'PLATFORM_EXPORT', contestId, {
      platform: options.platform,
      count: rows.length,
      includeUnofficial: options.includeUnofficial,
      importMode: options.importMode,
    });
    return {
      filename: `${options.platform.toLowerCase()}-${contestId}.zip`,
      files,
      count: rows.length,
    };
  });
}
