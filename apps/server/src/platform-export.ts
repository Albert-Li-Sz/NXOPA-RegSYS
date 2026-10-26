import { BadRequestException } from '@nestjs/common';
import {
  hydroExportFields,
  hydroMappableFields,
  hydroBuiltinSourceLabels,
  organizationSchema,
  policySchema,
  platformExportSchema,
  type Principal,
} from '@contest-center/contracts';
import { db, audit } from './db.js';
import { requireManager, sha } from './security.js';
import { ensureCompetitionAccount, validateCompetitionUsernames } from './competition-accounts.js';
import { modulesFor } from './workflow.js';
import { withExportBudget } from './export-budget.js';
import { hydroMappingFields, resolveHydroMapping } from './platform-export-mapping.js';

const jsonFile = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export async function platformExportFields(u: Principal, contestId: string) {
  requireManager(u, contestId, 'INTEGRATIONS');
  const contest = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
  if (!modulesFor(contest).integrations) throw new BadRequestException('此活动未启用平台文件导出');
  const forms = await db.formVersion.findMany({ where: { contestId } });
  return hydroMappingFields(forms, contest.formVersion);
}

// Generates a local snapshot only. Never contacts a judging platform.
export async function platformExport(u: Principal, contestId: string, body: unknown) {
  requireManager(u, contestId, 'INTEGRATIONS');
  const options = platformExportSchema.parse(body);
  const selected = new Set(options.hydroFields ?? hydroExportFields);
  const included = (field: (typeof hydroExportFields)[number]) =>
    options.platform !== 'HYDRO' || selected.has(field);
  const prefix = `cc_${contestId.replaceAll('-', '')}`;
  const official = options.officialGroupId ?? `${prefix}_official`;
  const unofficial = options.unofficialGroupId ?? `${prefix}_unofficial`;
  if (options.platform === 'DOMJUDGE' && official === unofficial)
    throw new BadRequestException('正式与非正式分组编号必须不同');
  return withExportBudget(u.id, contestId, () =>
    db.$transaction(
      async (tx) => {
        const started = Date.now();
        const contest = await tx.contest.findUniqueOrThrow({ where: { id: contestId } });
        if (!modulesFor(contest).integrations)
          throw new BadRequestException('此活动未启用平台文件导出');
        const mappings = options.hydroFieldMappings ?? {};
        const mappingFields = Object.values(mappings).some((source) => source.type === 'FORM_FIELD')
          ? hydroMappingFields(
              await tx.formVersion.findMany({ where: { contestId } }),
              contest.formVersion,
            )
          : [];
        for (const source of Object.values(mappings))
          if (
            source.type === 'FORM_FIELD' &&
            !mappingFields.some((f) => f.scope === source.scope && f.key === source.key)
          )
            throw new BadRequestException(
              `字段 ${source.scope}:${source.key} 不属于此活动的可关联报名字段`,
            );
        const fallbacks: Partial<Record<(typeof hydroMappableFields)[number], number>> = {};
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
              examSite: { select: { name: true } },
              participationType: true,
              organization: true,
              policySnapshot: true,
              answers: true,
              people: {
                where: { active: true },
                select: { id: true, name: true, captain: true, answers: true },
                orderBy: [{ captain: 'desc' }, { id: 'asc' }],
              },
              coaches: {
                select: { answers: true, user: { select: { name: true } } },
                orderBy: { id: 'asc' },
              },
              seats: {
                select: {
                  seat: true,
                  room: { select: { name: true, code: true, location: true } },
                },
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
        const usernames = await validateCompetitionUsernames(tx, contestId, contest.policy);
        const seats = new Map<string, string | number>();
        for (const r of rows) {
          const individual =
            policySchema.parse(r.policySnapshot ?? contest.policy).mode === 'INDIVIDUAL';
          let name = (individual ? r.people[0]?.name : r.teamName)?.trim() ?? '';
          const info = organizationSchema.safeParse(r.organization);
          const fields =
            (r.answers as { registration?: Record<string, unknown> }).registration ?? {};
          const assigned = r.seats[0];
          const rawSeat = assigned
            ? `${assigned.room.name}-${assigned.seat}`
            : String(fields.team_label ?? '').trim();
          let seat =
            options.platform === 'HYDRO'
              ? assigned?.room.code
                ? `${assigned.room.code}${String(assigned.seat).padStart(2, '0')}`
                : ''
              : `${prefix}-${rawSeat || r.number || r.id}`;
          let school = info.success ? info.data.name : '';
          let members = r.people.map((p) => p.name);
          let coach = r.coaches.map((c) => c.user.name).join('、');
          let usesDefaultSchool = true,
            usesDefaultSeat = true;
          if (options.platform === 'HYDRO') {
            const defaults = { displayName: name, school, members, coach, seat };
            for (const field of hydroMappableFields) {
              if (!included(field)) continue;
              const result = resolveHydroMapping(field, mappings[field], r, defaults);
              if (result.fallback) fallbacks[field] = (fallbacks[field] ?? 0) + 1;
              if (field === 'displayName') name = result.value as string;
              if (field === 'school') {
                school = result.value as string;
                usesDefaultSchool = result.usesDefault;
              }
              if (field === 'members') members = result.value as string[];
              if (field === 'coach') coach = result.value as string;
              if (field === 'seat') {
                seat = result.value as string;
                usesDefaultSeat = result.usesDefault;
              }
            }
          }
          if (!included('seat')) seat = '';
          if ((included('displayName') && !name) || (included('members') && !members.length))
            throw new BadRequestException(`报名 ${r.number ?? r.id} 缺少队名或成员姓名`);
          if (included('school') && usesDefaultSchool && !info.success)
            throw new BadRequestException(
              `报名 ${r.number ?? r.id} 缺少完整代表单位，请补正后重新审核`,
            );
          const usesSeatSource = Object.values(mappings).some(
            (source) => source.type === 'BUILTIN' && source.key === 'SEAT',
          );
          if (((included('seat') && usesDefaultSeat) || usesSeatSource) && r.seats.length > 1)
            throw new BadRequestException(
              `报名 ${r.number ?? r.id} 有多个成员座位，无法映射到一个平台队伍座位`,
            );
          if (seat && seats.has(seat))
            throw new BadRequestException(
              `报名 ${seats.get(seat)} 与 ${r.number ?? r.id} 座位重复：${seat}，请调整后重新导出`,
            );
          if (options.platform === 'HYDRO' && /[,\r\n]/.test(seat))
            throw new BadRequestException('Hydro 座位不能包含逗号或换行，请调整考场编号或关联资料');
          if (seat) seats.set(seat, r.number ?? r.id);
          const account = await ensureCompetitionAccount(tx, r.id, r.version, usernames);
          if (!account) throw new BadRequestException('此活动已关闭平台文件导出');
          const { username: loginName, password } = account;
          const unrank =
            options.importMode === 'FORCE_UNOFFICIAL' || r.participationType === 'UNOFFICIAL';
          credentials.push([r.number, name, loginName, password, seat, unrank ? '非正式' : '正式']);
          if (options.platform === 'HYDRO') {
            const team = {
              id: r.id,
              name: loginName,
              displayName: name,
              password,
              school,
              members,
              coach,
              seat,
              rank: !unrank,
            };
            teams.push(
              Object.fromEntries(
                hydroExportFields
                  .filter((field) => selected.has(field))
                  .map((field) => [field, team[field]]),
              ),
            );
          } else {
            if (!info.success) throw new BadRequestException('缺少完整代表单位');
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
              id: r.id,
              label: seat,
              name,
              display_name: name,
              group_ids: [unrank ? unofficial : official],
              organization_id: orgId,
              members: [r.teamEnglishName, ...r.people.map((p) => p.name)]
                .filter(Boolean)
                .join(' / '),
              ...(fields.team_icpc_id ? { icpc_id: String(fields.team_icpc_id) } : {}),
              location: {
                description: assigned?.room.location || String(fields.team_location ?? ''),
              },
            });
            accounts.push({
              id: r.id,
              username: loginName,
              password,
              type: 'team',
              team_id: r.id,
              name,
            });
          }
        }
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
        const credentialColumns = [
          0,
          ...(included('displayName') ? [1] : []),
          2,
          ...(included('password') ? [3] : []),
          ...(included('seat') ? [4] : []),
          5,
        ];
        files['credentials.csv'] =
          '\uFEFF' +
          credentials
            .map((r) => credentialColumns.map((i) => csvCell(r[i])).join(','))
            .join('\r\n') +
          '\r\n';
        files['README.txt'] =
          options.platform === 'HYDRO'
            ? 'Hydro 最新版 + @hydrooj/onsite-toolkit：\n启用 extraFields、contestMode；需要 IP 登录时再启用 ipLogin。\n以 Hydro 运行用户执行：\nhydrooj cli system onsiteImport /绝对路径/teams.json 比赛ObjectId webp 域ID\n默认域填 system；多个比赛ID用逗号连接，逗号后不加空项。\nid 固定为报名 UUID；name 为个人本人／团队队长的学号，保留前导零并按 Hydro 规则规范化；displayName 为队名／姓名。\nmembers 仅填写一次，不同时输出 member1–member4；rank 为布尔值，true 正式、false 非正式。\nseat 使用考场编号加至少两位座位序号，如 A01、A100；未排座或未填考场编号时为空，不使用活动前缀或报名编号。\n两个平台和准考证共用本人／队长学号及同一个比赛密码；首次导出或生成准考证时随机生成，重复操作保持不变；导出 password 时重新导入会将远端密码重置成文件中的密码。\n按每次比赛清空 Hydro 的使用方式导出，不兼容旧导入账号或跨活动账号复用。部分外榜只显示学号，请赛前核对 displayName 的显示。\nIP 未自动填写；需要时用非空的 seat 和无表头的“seat,ip”CSV执行 setIpLogin。\n'
            : 'DOMjudge 9.x：后台 Import / export → Import JSON / YAML，依次导入 groups.json、organizations.json、teams.json、accounts.json。\n用户导入类型选 accounts，不是 users；account.type 固定为 team，team_id 对应队伍外部 id。\n正式和非正式组使用不同 sortorder，在目标比赛配置中允许对应分组参赛。\n重复导入队伍按外部ID更新；已有用户可能跳过或拒绝更新，改名／密码请在远端后台核对。\n队伍与账号 ID 使用稳定的报名 UUID；用户名为本人／队长学号，与 Hydro 和准考证共用密码。\n';
        if (options.platform === 'HYDRO')
          files['README.txt'] +=
            `\n本次字段：${hydroExportFields.filter((field) => selected.has(field)).join('、')}。\n取消 password 时整个包不含比赛密码；已有 Hydro 账号不会重设密码，新账号由 Hydro 随机生成密码，可能与准考证密码不同。\n省略 members 时，Hydro 默认空数组，重新导入可能清空已有成员。自选字段控制文件内容，不代表远端部分更新。\n`;
        if (options.platform === 'HYDRO' && Object.keys(mappings).length) {
          files['README.txt'] += '\n本次报名资料关联（仅本次导出生效）：\n';
          for (const field of hydroMappableFields) {
            const source = mappings[field];
            if (!source) continue;
            const description =
              source.type === 'BUILTIN'
                ? hydroBuiltinSourceLabels[source.key]
                : `${source.scope}·${mappingFields.find((f) => f.scope === source.scope && f.key === source.key)!.label}（${source.key}）`;
            files['README.txt'] +=
              `${field} ← ${description}；缺值回退 ${fallbacks[field] ?? 0} 份报名。\n`;
          }
          files['README.txt'] +=
            '成员字段逐人取值，缺值逐人回退姓名；其他单值字段取本人／队长资料，多个选项或教练用“、”连接。映射值为空时回退该项系统默认来源；成员数组保留多选项，单个文本作为一名成员，不按逗号拆分。附件和照片不能作为来源。默认一键导出始终使用系统规则。\n';
        }
        files['README.txt'] +=
          '\n本包只包含本次取得参赛资格的报名，不会自动导入或删除远端账号。资格撤销／报名删除后，请在远端手动处理。\n凭据表仅在选择 password 时包含明文比赛密码，请妥善分发和销毁。本站密码与比赛密码独立；两个平台和准考证共用比赛凭据。\n完整教程：https://albert-li-sz.github.io/NXOPA-RegSYS/\n';
        await audit(tx, u.id, 'PLATFORM_EXPORT', contestId, {
          platform: options.platform,
          count: rows.length,
          includeUnofficial: options.includeUnofficial,
          importMode: options.importMode,
          ...(options.platform === 'HYDRO'
            ? {
                hydroFields: hydroExportFields.filter((field) => selected.has(field)),
                hydroFieldMappings: mappings,
                fallbacks,
              }
            : {}),
        });
        return {
          filename: `${options.platform.toLowerCase()}-${contestId}.zip`,
          files,
          count: rows.length,
        };
      },
      { timeout: 120000, maxWait: 10000 },
    ),
  );
}
