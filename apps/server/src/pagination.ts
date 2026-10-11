import { z } from 'zod';
import type { PageResult } from '@contest-center/contracts';

export type ListQuery = Record<string, string | undefined>;
export function pageOptions(query: ListQuery = {}) {
  if (query.page === undefined && query.pageSize === undefined) return null;
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .parse(query.page ?? 1);
  const pageSize = z.coerce
    .number()
    .int()
    .refine((n) => [20, 50, 100].includes(n), '每页支持 20、50、100 条')
    .parse(query.pageSize ?? 20);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
export async function paginated<T>(
  query: ListQuery,
  find: (options: { skip?: number; take: number }) => Promise<T[]>,
  count: () => Promise<number>,
  legacyTake = 500,
): Promise<T[] | PageResult<T>> {
  const p = pageOptions(query);
  if (!p) return find({ take: legacyTake });
  const [items, total] = await Promise.all([find({ skip: p.skip, take: p.take }), count()]);
  return { items, total, page: p.page, pageSize: p.pageSize };
}
export function dateFilter(query: ListQuery) {
  const from = query.from ? z.iso.datetime({ offset: true }).parse(query.from) : undefined;
  const to = query.to ? z.iso.datetime({ offset: true }).parse(query.to) : undefined;
  return from || to
    ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) }
    : undefined;
}
