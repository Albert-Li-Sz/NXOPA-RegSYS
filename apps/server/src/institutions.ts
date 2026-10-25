import { readFile } from 'node:fs/promises';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  institutionInputSchema,
  normalizeInstitutionName,
  type Principal,
} from '@contest-center/contracts';
import { db, json, lock, audit, type Tx } from './db.js';
import { requireSystemAdmin, checkVersion } from './security.js';
import { paginated, type ListQuery } from './pagination.js';

export async function seedInstitutions() {
  const source = JSON.parse(
    await readFile(new URL('./data/institutions-moe-2026.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
    institutions: { code: string; name: string; province: string; city: string }[];
  };
  await db.$transaction(
    async (tx) => {
      await lock(tx, 'seed:institutions');
      const key = `seed:${source.version}`;
      if (await tx.setting.findUnique({ where: { key } })) return;
      // Existing administrative edits, disabled entries and custom institutions survive restarts.
      await tx.institution.createMany({
        data: source.institutions.map((row) => ({
          ...row,
          normalizedName: normalizeInstitutionName(row.name),
          source: source.version,
          searchText: normalizeInstitutionName(
            `${row.name} ${row.province} ${row.city} ${row.code}`,
          ),
        })),
        skipDuplicates: true,
      });
      await tx.setting.create({ data: { key, value: { count: source.institutions.length } } });
    },
    { timeout: 120000 },
  );
}

/** Old names remain readable/retainable; a newly selected name must be enabled in the directory. */
export async function validateInstitution(tx: Tx, value: unknown, previous?: unknown) {
  if (value === undefined || value === null || value === '') return;
  const name = z.string().trim().max(200).parse(value);
  if (
    typeof previous === 'string' &&
    normalizeInstitutionName(name) === normalizeInstitutionName(previous)
  )
    return;
  if (
    !(await tx.institution.findFirst({
      where: { normalizedName: normalizeInstitutionName(name), enabled: true },
      select: { id: true },
    }))
  )
    throw new BadRequestException('请从院校或单位目录选择；目录中没有的单位请联系管理员添加');
}

@Injectable()
export class InstitutionService {
  list(u: Principal, query: ListQuery, admin = false) {
    if (admin) requireSystemAdmin(u);
    const search = normalizeInstitutionName(
      z
        .string()
        .max(100)
        .parse(query.search ?? ''),
    );
    const where = {
      ...(!admin
        ? { enabled: true }
        : query.enabled
          ? { enabled: z.enum(['true', 'false']).parse(query.enabled) === 'true' }
          : {}),
      ...(search ? { searchText: { contains: search } } : {}),
    };
    return paginated(
      { page: '1', pageSize: '50', ...query },
      (options) =>
        db.institution.findMany({
          where,
          ...options,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          ...(!admin
            ? {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  shortName: true,
                  country: true,
                  province: true,
                  city: true,
                },
              }
            : {}),
        }),
      () => db.institution.count({ where }),
    );
  }
  async save(u: Principal, body: unknown, id?: string) {
    requireSystemAdmin(u);
    const b = institutionInputSchema.parse(body);
    if (id) z.string().uuid().parse(id);
    return db.$transaction(async (tx) => {
      await lock(tx, 'institutions:edit');
      const old = id ? await tx.institution.findUnique({ where: { id } }) : null;
      if (id && !old) throw new NotFoundException('院校或单位不存在');
      if (old) checkVersion(old.version, b.version ?? 0);
      // Names are stored in historical identity and registration records; keep their meaning stable.
      if (old && old.name !== b.name)
        throw new BadRequestException('院校名称不可改名，请停用原条目并添加新单位');
      const { version: _, ...input } = b;
      const data = {
        ...input,
        normalizedName: normalizeInstitutionName(b.name),
        searchText: normalizeInstitutionName(
          [b.name, b.shortName, b.province, b.city, old?.code, ...b.aliases]
            .filter(Boolean)
            .join(' '),
        ),
      };
      const row = old
        ? await tx.institution.update({
            where: { id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.institution.create({ data });
      await audit(
        tx,
        u.id,
        old ? 'INSTITUTION_EDIT' : 'INSTITUTION_CREATE',
        row.id,
        json({ name: row.name, enabled: row.enabled }),
      );
      return row;
    });
  }
}
