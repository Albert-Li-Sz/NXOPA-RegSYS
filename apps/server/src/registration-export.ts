import ExcelJS from 'exceljs';
import { z } from 'zod';
import { competitionCredentials } from './competition-accounts.js';
import { BadRequestException } from '@nestjs/common';
import { fieldsSchema, type Principal, type FieldDefinition } from '@contest-center/contracts';
import { db, audit } from './db.js';
import { requireManager, manages } from './security.js';
import type { RegistrationService } from './registrations.js';
import { withExportBudget } from './export-budget.js';
import type { ListQuery } from './pagination.js';

const scopeLabels = { PERSON: '成员', TEAM: '队伍', REGISTRATION: '报名', COACH: '老师' };
const escapeCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export async function registrationExport(
  service: RegistrationService,
  user: Principal,
  id: string,
  query: ListQuery,
) {
  requireManager(user, id, 'REGISTRATIONS');
  const format = z.enum(['csv', 'xlsx']).parse(query.format ?? 'csv');
  const includeCredentials =
    z.enum(['true', 'false']).parse(query.includeCredentials ?? 'false') === 'true';
  return withExportBudget(user.id, id, async () => {
    const started = Date.now();
    const filter = { ...query };
    delete filter.page;
    delete filter.pageSize;
    delete filter.format;
    delete filter.includeCredentials;
    const records: any[] = [];
    let cursor: string | undefined;
    let rowCount = 0,
      scannedBytes = 0;
    const batchSize = 10;
    while (true) {
      const rows = await service.exportRows(user, id, cursor, batchSize, filter);
      if (Date.now() - started > 120000) throw new BadRequestException('导出超时，请缩小范围');
      const batch = rows.map((r) => ({
        ...r,
        // These copies are not export columns and can contain large submissions.
        snapshot: undefined,
        policySnapshot: undefined,
        contest: undefined,
        people: r.people
          .filter((p: any) => p.active)
          .sort(
            (a: any, b: any) => Number(b.captain) - Number(a.captain) || a.id.localeCompare(b.id),
          ),
        coaches: [...r.coaches].sort((a: any, b: any) => a.id.localeCompare(b.id)),
      }));
      for (const record of batch) {
        scannedBytes += Buffer.byteLength(JSON.stringify(record));
        if (scannedBytes > 50 * 1024 * 1024)
          throw new BadRequestException('导出扫描资料超过 50 MB，请缩小筛选范围');
        records.push(record);
      }
      if (scannedBytes > 50 * 1024 * 1024)
        throw new BadRequestException('导出扫描资料超过 50 MB，请缩小筛选范围');
      rowCount += rows.reduce((n, r) => n + r.people.filter((p: any) => p.active).length, 0);
      if (rowCount > 10000)
        throw new BadRequestException('单次最多导出 10000 位成员，请缩小筛选范围');
      if (rows.length < batchSize) break;
      cursor = rows.at(-1)!.id;
    }
    const forms = await db.formVersion.findMany({
      where: {
        contestId: id,
        ...(records.length
          ? { version: { in: [...new Set(records.map((r) => r.formVersion))] } }
          : {}),
      },
      orderBy: { version: 'desc' },
      ...(records.length ? {} : { take: 1 }),
    });
    const fields = new Map<string, FieldDefinition>();
    for (const form of forms)
      for (const field of fieldsSchema.parse(form.fields)) {
        const key = `${field.scope}:${field.key}`;
        if (!fields.has(key)) fields.set(key, field);
      }
    // Include historical answer keys even when an administrator removed a field.
    const collect = (scope: FieldDefinition['scope'], answers: Record<string, unknown> = {}) => {
      for (const key of Object.keys(answers))
        if (!fields.has(`${scope}:${key}`))
          fields.set(`${scope}:${key}`, {
            key,
            label: key,
            scope,
            type: 'text',
            required: false,
            sensitive: false,
            options: [],
            help: '',
            group: '历史字段',
            locked: false,
          });
    };
    for (const r of records) {
      collect('REGISTRATION', r.answers?.registration);
      collect('TEAM', r.answers?.team);
      for (const p of r.people) collect('PERSON', p.answers);
      for (const c of r.coaches) collect('COACH', c.answers);
    }
    const coachCount = Math.max(
      [...fields.values()].some((field) => field.scope === 'COACH') ? 1 : 0,
      ...records.map((r) => r.coaches.length),
    );
    const columns: { name: string; value: (r: any, p: any) => unknown }[] = [
      { name: '报名编号', value: (r) => r.number },
      { name: '报名ID', value: (r) => r.id },
      { name: '队名', value: (r) => r.teamName },
      { name: '队伍英文名', value: (r) => r.teamEnglishName },
      {
        name: '参加性质',
        value: (r) => (r.participationType === 'UNOFFICIAL' ? '非正式' : '正式'),
      },
      { name: '考点', value: (r) => r.examSite?.name },
      { name: '考点地址', value: (r) => r.examSite?.address },
      { name: '代表学校／单位', value: (r) => r.organization?.name },
      {
        name: '考场',
        value: (r) => [...new Set((r.seats ?? []).map((s: any) => s.room.name))].join('；'),
      },
      {
        name: '座位',
        value: (r, p) =>
          (r.seats ?? [])
            .filter((s: any) => !s.personId || s.personId === p.id)
            .map((s: any) => String(s.seat))
            .join('；'),
      },
      { name: '姓名', value: (_, p) => p.name },
      { name: '邮箱', value: (_, p) => p.email },
      { name: '队长', value: (_, p) => (p.captain ? '是' : '否') },
      { name: '报名状态', value: (r) => r.status },
      { name: '审核', value: (r) => r.review },
      { name: '资格', value: (r) => (r.eligible ? '是' : '否') },
      {
        name: '提交时间（北京时间）',
        value: (r) =>
          r.submittedAt?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      },
    ];
    if (includeCredentials) {
      const accounts = new Map<string, { username: string; password: string }>();
      for (const r of records) {
        const account = await competitionCredentials(r.id);
        if (account) accounts.set(r.id, account);
      }
      columns.push(
        { name: '比赛账号', value: (r) => accounts.get(r.id)?.username },
        { name: '比赛密码', value: (r) => accounts.get(r.id)?.password },
      );
    }
    if (manages(user, id, 'FINANCE'))
      columns.push(
        {
          name: '应收(元)',
          value: (r, p) => (p.id === r.people[0]?.id ? (r.feeCents / 100).toFixed(2) : ''),
        },
        {
          name: '净到账(元)',
          value: (r, p) => (p.id === r.people[0]?.id ? (r.netPaidCents / 100).toFixed(2) : ''),
        },
      );
    const answer = (value: any): string => {
      if (value == null) return '';
      if (typeof value === 'boolean') return value ? '是' : '否';
      if (Array.isArray(value)) return value.map(answer).join('；');
      if (typeof value === 'object') {
        const attachmentId = value.attachmentId ?? value.id;
        if (typeof attachmentId === 'string') return String(value.name ?? attachmentId);
        return Object.entries(value)
          .map(([key, v]) => `${key}：${answer(v)}`)
          .join('；');
      }
      return String(value);
    };
    for (const field of fields.values()) {
      if (field.scope === 'COACH') continue;
      columns.push({
        name: `${scopeLabels[field.scope]}·${field.label} (${field.key})`,
        value: (r, p) =>
          answer(
            field.scope === 'PERSON'
              ? p.answers?.[field.key]
              : r.answers?.[field.scope === 'TEAM' ? 'team' : 'registration']?.[field.key],
          ),
      });
    }
    for (let index = 0; index < coachCount; index++) {
      columns.push(
        { name: `老师${index + 1}·姓名`, value: (r) => r.coaches[index]?.user.name },
        { name: `老师${index + 1}·邮箱`, value: (r) => r.coaches[index]?.user.email },
      );
      for (const field of fields.values())
        if (field.scope === 'COACH')
          columns.push({
            name: `老师${index + 1}·${field.label} (${field.key})`,
            value: (r) => answer(r.coaches[index]?.answers?.[field.key]),
          });
    }
    if (columns.length > 500) throw new BadRequestException('历史字段超过 500 列，请缩小导出范围');
    const workbook = format === 'xlsx' ? new ExcelJS.Workbook() : null;
    const sheet = workbook?.addWorksheet('报名信息', { views: [{ state: 'frozen', ySplit: 1 }] });
    if (sheet) {
      sheet.columns = columns.map((c) => ({
        header: c.name,
        width: Math.min(40, Math.max(16, c.name.length * 2 + 2)),
        style: { numFmt: '@' },
      }));
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    }
    const lines = [columns.map((c) => escapeCell(c.name)).join(',')];
    let bytes = Buffer.byteLength(lines[0]!);
    for (const r of records)
      for (const p of r.people) {
        const line = columns.map((c) => escapeCell(c.value(r, p))).join(',');
        bytes += Buffer.byteLength(line) + 2;
        if (bytes > 25 * 1024 * 1024)
          throw new BadRequestException('导出内容超过 25 MB，请缩小筛选范围');
        if (sheet) sheet.addRow(columns.map((c) => String(c.value(r, p) ?? '')));
        else lines.push(line);
      }
    await audit(db, user.id, 'REGISTRATION_EXPORT', id, {
      registrations: records.length,
      rows: rowCount,
      columns: columns.length,
      format,
      credentialsIncluded: includeCredentials,
      financeIncluded: manages(user, id, 'FINANCE'),
      filters: filter,
    });
    const content = workbook
      ? Buffer.from(await workbook.xlsx.writeBuffer())
      : '\uFEFF' + lines.join('\r\n') + '\r\n';
    if (Buffer.byteLength(content) > 25 * 1024 * 1024)
      throw new BadRequestException('导出内容超过 25 MB，请缩小筛选范围');
    return {
      format,
      content,
      mime:
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
    };
  });
}
