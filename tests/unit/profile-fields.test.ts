import { describe, expect, it } from 'vitest';
import {
  defaultFields,
  fieldsSchema,
  studentProfileSchema,
} from '../../packages/contracts/src/index.js';
import {
  normalizeEnrollmentYear,
  normalizeProfileYears,
  maximumEnrollmentYear,
  fieldsJsonSchema,
  normalizeInstitutionName,
} from '../../packages/contracts/src/index.js';
import { readFileSync } from 'node:fs';

describe('participant profile field compatibility', () => {
  it('normalizes recognizable historical years and clears unreasonable data without touching custom values', () => {
    for (const value of [2023, '2023', ' 2023年 ', '2023级', '２０２３', '2023.0'])
      expect(normalizeEnrollmentYear(value)).toBe(2023);
    for (const value of [1949, 9999, '23', '大三', '2023-09-01', 2023.5, null, ''])
      expect(normalizeEnrollmentYear(value)).toBeUndefined();
    expect(
      normalizeProfileYears({
        enrollment_year: '9999',
        student_id: '0000123',
        custom: { kept: true },
      }),
    ).toEqual({ student_id: '0000123', custom: { kept: true } });
    expect(() => normalizeProfileYears({ enrollment_year: 9999 }, true)).toThrow();
    expect(normalizeProfileYears({ enrollment_year: '', school: '原有单位' }, true)).toEqual({
      school: '原有单位',
    });
  });
  it('uses the Chinese calendar boundary and allows next year only', () => {
    const before = new Date('2026-12-31T15:59:59Z'),
      after = new Date('2026-12-31T16:00:00Z');
    expect(maximumEnrollmentYear(before)).toBe(2027);
    expect(maximumEnrollmentYear(after)).toBe(2028);
    expect(normalizeEnrollmentYear(2028, before)).toBeUndefined();
    expect(normalizeEnrollmentYear(2028, after)).toBe(2028);
  });
  it('normalizes old field types and generates numeric year and email constraints', () => {
    const fields = fieldsSchema.parse([
      { key: 'enrollment_year', label: '入学年', scope: 'PERSON', type: 'text' },
      { key: 'school', label: '学校', scope: 'PERSON', type: 'text' },
      { key: 'email', label: '电子邮箱', scope: 'PERSON', type: 'text' },
    ]);
    expect(fields.map((f) => f.type)).toEqual(['year', 'institution', 'email']);
    expect(fieldsJsonSchema(fields, 'PERSON').properties).toMatchObject({
      enrollment_year: { type: 'integer', minimum: 1950, maximum: maximumEnrollmentYear() },
      email: { format: 'email' },
    });
  });
  it('bundles the complete official undergraduate directory with provenance and unique names/codes', () => {
    const source = JSON.parse(
      readFileSync(
        new URL('../../apps/server/src/data/institutions-moe-2026.json', import.meta.url),
        'utf8',
      ),
    );
    expect(source.institutions).toHaveLength(1412);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.source).toMatch(/^https:\/\/www.moe.gov.cn\//);
    expect(new Set(source.institutions.map((row: any) => row.code)).size).toBe(1412);
    expect(
      new Set(source.institutions.map((row: any) => normalizeInstitutionName(row.name))).size,
    ).toBe(1412);
    expect(source.institutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '南京晓庄学院', province: '江苏省' }),
      ]),
    );
  });
  it('rejects impossible enrollment years while keeping legacy profiles without a year', () => {
    const profile = {
      student_id: '002026001',
      class_name: '一班',
      college: '信息学院',
      gender: '男',
    };
    expect(studentProfileSchema.safeParse({ ...profile, enrollment_year: 9999 }).success).toBe(
      false,
    );
    expect(studentProfileSchema.safeParse(profile).success).toBe(true);
  });
  it('normalizes stored identifier labels', () => {
    const fields = fieldsSchema.parse([
      { key: 'student_id', label: '学号 / 参赛编号', scope: 'PERSON', type: 'text' },
    ]);
    expect(fields[0]?.label).toBe('学号');
  });
  it('includes a private email field in new default forms', () => {
    expect(defaultFields.find((f) => f.key === 'email' && f.scope === 'PERSON')).toMatchObject({
      type: 'email',
      sensitive: true,
    });
  });
});
