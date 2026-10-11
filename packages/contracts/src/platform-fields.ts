import { fieldsSchema, type FieldDefinition } from './index.js';

export const platformTemplates = [
  {
    id: 'HYDRO_5_0_7',
    name: 'Hydro 5.0.7',
    participant: ['姓名', '联系人邮箱', '队伍名称（团队）', '代表学校／单位', '参赛性质'],
    generated: ['独立比赛用户名', '独立比赛密码', '远端用户编号'],
    administrator: ['域编号', '比赛编号', '昵称映射', '非正式参赛导入策略'],
  },
  {
    id: 'DOMJUDGE_9_0_1',
    name: 'DOMjudge 9.0.1',
    participant: [
      '姓名',
      '联系人邮箱',
      '队伍名称（团队）',
      '代表学校／单位',
      '学校简称',
      '国家／地区',
      '参赛性质',
      '英文队名（可选）',
      'ICPC 编号（可选）',
      '队伍编号／座位（可选）',
      '地点（可选）',
    ],
    generated: ['独立比赛用户名', '独立比赛密码', '远端队伍与账号编号', '账号角色'],
    administrator: ['学校映射', '正式／非正式分组', '比赛编号'],
  },
] as const;
export function requiredPlatformFields(profiles: string[]): FieldDefinition[] {
  return profiles.includes('DOMJUDGE_9_0_1')
    ? fieldsSchema.parse([
        {
          key: 'team_icpc_id',
          label: '队伍 ICPC 编号',
          scope: 'REGISTRATION',
          type: 'text',
          locked: true,
          source: 'DOMJUDGE_9_0_1',
          group: '平台基础信息',
        },
        {
          key: 'team_label',
          label: '队伍编号／座位',
          scope: 'REGISTRATION',
          type: 'text',
          locked: true,
          source: 'DOMJUDGE_9_0_1',
          group: '平台基础信息',
        },
        {
          key: 'team_location',
          label: '队伍地点',
          scope: 'REGISTRATION',
          type: 'text',
          locked: true,
          source: 'DOMJUDGE_9_0_1',
          group: '平台基础信息',
        },
      ])
    : [];
}
export function mergePlatformFields(
  fields: FieldDefinition[],
  profiles: string[],
): FieldDefinition[] {
  const fixed = requiredPlatformFields(profiles);
  return [
    ...fields.filter((f) => !fixed.some((x) => x.scope === f.scope && x.key === f.key)),
    ...fixed,
  ];
}
