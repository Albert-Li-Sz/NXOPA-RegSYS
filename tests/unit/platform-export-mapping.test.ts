import { describe, expect, it } from 'vitest';
import { platformExportSchema } from '../../packages/contracts/src/index.js';
import {
  hydroMappingFields,
  resolveHydroMapping,
} from '../../apps/server/src/platform-export-mapping.js';

const row = {
  number: 12,
  teamName: '测试队',
  teamEnglishName: 'Test Team',
  organization: { name: '测试大学' },
  answers: {
    team: { title: '自定义队名' },
    registration: { school: '自定义学校', zero: 0, flag: false },
  },
  people: [
    { name: '队长', answers: { alias: '0001', tags: ['算法', '开发'] } },
    { name: '成员二', answers: { alias: '' } },
    { name: '成员三', answers: { alias: '张三' } },
    { name: '成员四', answers: { alias: '李四' } },
    { name: '成员五', answers: {} },
  ],
  coaches: [
    { user: { name: '老师甲' }, answers: { alias: '教练甲' } },
    { user: { name: '老师乙' }, answers: { alias: '教练乙' } },
  ],
  examSite: { name: '第一考点' },
};
const defaults = {
  displayName: row.teamName,
  school: '测试大学',
  members: row.people.map((p) => p.name),
  coach: '老师甲、老师乙',
  seat: 'A01',
};
const form = (scope: 'PERSON' | 'TEAM' | 'REGISTRATION' | 'COACH', key: string) => ({
  type: 'FORM_FIELD' as const,
  scope,
  key,
});

describe('transient Hydro registration mappings', () => {
  it('maps builtin names without changing identity or default values', () => {
    expect(
      resolveHydroMapping('displayName', { type: 'BUILTIN', key: 'PERSON_NAME' }, row, defaults)
        .value,
    ).toBe('队长');
    expect(
      resolveHydroMapping('displayName', { type: 'BUILTIN', key: 'TEAM_NAME' }, row, defaults)
        .value,
    ).toBe('测试队');
    expect(resolveHydroMapping('displayName', undefined, row, defaults)).toEqual({
      value: '测试队',
      fallback: false,
      usesDefault: true,
    });
    expect(defaults.displayName).toBe('测试队');
  });
  it('reads scoped custom fields, all coaches and scalar/multiselect values', () => {
    expect(resolveHydroMapping('displayName', form('TEAM', 'title'), row, defaults).value).toBe(
      '自定义队名',
    );
    expect(resolveHydroMapping('school', form('REGISTRATION', 'school'), row, defaults).value).toBe(
      '自定义学校',
    );
    expect(resolveHydroMapping('coach', form('COACH', 'alias'), row, defaults).value).toBe(
      '教练甲、教练乙',
    );
    expect(resolveHydroMapping('displayName', form('PERSON', 'tags'), row, defaults).value).toBe(
      '算法、开发',
    );
    expect(resolveHydroMapping('members', form('TEAM', 'title'), row, defaults).value).toEqual([
      '自定义队名',
    ]);
    expect(resolveHydroMapping('members', form('PERSON', 'tags'), row, defaults).value).toEqual([
      '算法',
      '开发',
      '成员二',
      '成员三',
      '成员四',
      '成员五',
    ]);
  });
  it('preserves leading zeros, zero and false and falls back per member for any team size', () => {
    expect(resolveHydroMapping('members', form('PERSON', 'alias'), row, defaults)).toEqual({
      value: ['0001', '成员二', '张三', '李四', '成员五'],
      fallback: true,
      usesDefault: false,
    });
    expect(
      resolveHydroMapping('displayName', form('REGISTRATION', 'zero'), row, defaults).value,
    ).toBe('0');
    expect(
      resolveHydroMapping('displayName', form('REGISTRATION', 'flag'), row, defaults).value,
    ).toBe('否');
  });
  it('uses defaults for missing, whitespace, empty array and object values', () => {
    for (const value of [
      null,
      undefined,
      '',
      '  ',
      [],
      {},
      { attachmentId: 'private-id', name: 'file.pdf' },
    ]) {
      const changed = { ...row, answers: { registration: { blank: value } } };
      expect(
        resolveHydroMapping('displayName', form('REGISTRATION', 'blank'), changed, defaults),
      ).toEqual({ value: defaults.displayName, fallback: true, usesDefault: true });
    }
    expect(
      resolveHydroMapping('seat', { type: 'BUILTIN', key: 'SEAT' }, row, defaults).usesDefault,
    ).toBe(true);
  });
  it('lists current and removed historical fields once, excluding attachments and unsafe type changes', () => {
    const catalog = hydroMappingFields(
      [
        {
          version: 1,
          fields: [
            { key: 'alias', label: '旧称', scope: 'PERSON', type: 'text' },
            { key: 'removed', label: '已移除字段', scope: 'TEAM', type: 'text' },
            { key: 'changed', label: '旧文本', scope: 'TEAM', type: 'text' },
          ],
        },
        {
          version: 2,
          fields: [
            { key: 'alias', label: '新称', scope: 'PERSON', type: 'text' },
            { key: 'changed', label: '附件', scope: 'TEAM', type: 'file' },
            { key: 'portrait', label: '照片', scope: 'PERSON', type: 'photo' },
          ],
        },
      ],
      2,
    );
    expect(catalog).toEqual([
      { key: 'alias', label: '新称', scope: 'PERSON', type: 'text', historical: false },
      { key: 'removed', label: '已移除字段', scope: 'TEAM', type: 'text', historical: true },
    ]);
  });
  it('rejects locked fields, unknown sources, prototype keys, excluded targets and DOMjudge mappings', () => {
    const source = { type: 'BUILTIN', key: 'PERSON_NAME' };
    expect(
      platformExportSchema.parse({ platform: 'HYDRO', hydroFieldMappings: { displayName: source } })
        .hydroFieldMappings,
    ).toEqual({ displayName: source });
    for (const hydroFieldMappings of [
      { name: source },
      { id: source },
      { password: source },
      { rank: source },
      { displayName: { type: 'BUILTIN', key: 'PASSWORD' } },
      { displayName: { type: 'FORM_FIELD', scope: 'PERSON', key: 'constructor' } },
      { displayName: { type: 'FORM_FIELD', scope: 'PERSON', key: 'a.b' } },
      { displayName: { ...source, extra: 'hidden' } },
    ])
      expect(
        platformExportSchema.safeParse({ platform: 'HYDRO', hydroFieldMappings }).success,
      ).toBe(false);
    expect(
      platformExportSchema.safeParse({ platform: 'DOMJUDGE', hydroFieldMappings: {} }).success,
    ).toBe(false);
    expect(
      platformExportSchema.safeParse({
        platform: 'HYDRO',
        hydroFields: ['id', 'name', 'rank'],
        hydroFieldMappings: { displayName: source },
      }).success,
    ).toBe(false);
  });
});
