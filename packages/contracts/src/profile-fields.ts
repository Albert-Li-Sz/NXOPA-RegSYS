import { z } from 'zod';

export const minimumEnrollmentYear = 1950;
const yearClock = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' });
export function maximumEnrollmentYear(now = new Date()) {
  return Number(yearClock.format(now)) + 1;
}
export function normalizeEnrollmentYear(value: unknown, now = new Date()): number | undefined {
  let year: number;
  if (typeof value === 'number') year = value;
  else if (typeof value === 'string') {
    const match = /^(\d{4})(?:年|级|\.0+)?$/.exec(value.normalize('NFKC').trim());
    if (!match) return undefined;
    year = Number(match[1]);
  } else return undefined;
  return Number.isInteger(year) &&
    year >= minimumEnrollmentYear &&
    year <= maximumEnrollmentYear(now)
    ? year
    : undefined;
}
export const enrollmentYearSchema = z
  .union([z.number(), z.string()])
  .refine(
    (value) => normalizeEnrollmentYear(value) !== undefined,
    '请选择有效入学年份（1950 年至下一年）',
  );
/** Canonicalize only the reserved year field; all unrelated custom answers survive. */
export function normalizeProfileYears<T extends Record<string, unknown>>(
  profile: T,
  strict = false,
): T {
  const result = { ...profile };
  if (!Object.hasOwn(result, 'enrollment_year')) return result;
  const raw = result.enrollment_year;
  if (strict && raw !== '' && raw !== null && raw !== undefined) enrollmentYearSchema.parse(raw);
  const year = normalizeEnrollmentYear(raw);
  if (year === undefined) delete result.enrollment_year;
  else (result as Record<string, unknown>).enrollment_year = year;
  return result;
}
export function normalizeInstitutionName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
export interface InstitutionOption {
  id: string;
  name: string;
  shortName: string;
  country: string;
  province: string;
  city: string;
  code: string | null;
}
export const institutionInputSchema = z.object({
  version: z.number().int().positive().optional(),
  name: z.string().trim().min(2).max(200),
  shortName: z.string().trim().max(80).default(''),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .default('CHN'),
  province: z.string().trim().max(80).default(''),
  city: z.string().trim().max(100).default(''),
  aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  enabled: z.boolean().default(true),
});
