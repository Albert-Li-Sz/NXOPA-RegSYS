import type { Principal } from '@contest-center/contracts';

export const adminCenters = [
  {
    key: 'contests',
    to: '/admin/contests',
    label: '活动及竞赛管理中心',
    description: '管理活动、竞赛与报名流程',
    tabs: [{ name: 'contests', label: '活动及竞赛管理' }],
  },
  {
    key: 'platforms',
    to: '/admin/platforms',
    label: '外接平台中心',
    description: '配置外部评测平台及竞赛绑定',
    tabs: [{ name: 'instances', label: '评测平台' }],
  },
  {
    key: 'users',
    to: '/admin/users',
    label: '用户中心',
    description: '学生、教师、账号邀请与管理员授权',
    tabs: [
      { name: 'students', label: '学生视图' },
      { name: 'teachers', label: '教师视图' },
      { name: 'users', label: '用户与邀请' },
      { name: 'grants', label: '管理员授权' },
    ],
  },
  {
    key: 'tasks',
    to: '/admin/tasks',
    label: '日志与任务中心',
    description: '审计日志与后台任务',
    tabs: [
      { name: 'jobs', label: '任务' },
      { name: 'audit', label: '审计日志' },
    ],
  },
  {
    key: 'reviews',
    to: '/admin/reviews',
    label: '审核中心',
    description: '审核学生与教师的实名资料',
    tabs: [{ name: 'identities', label: '实名审核' }],
  },
  {
    key: 'settings',
    to: '/admin',
    label: '管理中心',
    description: '全局配置与系统服务',
    tabs: [
      { name: 'site', label: '全局设置' },
      { name: 'tokens', label: 'API 与 Webhook' },
      { name: 'mail', label: '邮件设置' },
      { name: 'mail-templates', label: '邮件模板' },
      { name: 'storage', label: '文件存储' },
      { name: 'github', label: 'GitHub 登录' },
      { name: 'feishu', label: '飞书登录' },
    ],
  },
];

export function centerTabs(key: string, user: Principal | null) {
  const center = adminCenters.find((c) => c.key === key);
  if (!center || !user || (!user.isAdmin && !user.contestIds.length)) return [];
  if (key === 'settings') return user.isSystemAdmin ? center.tabs : [];
  if (key === 'reviews') return user.isAdmin ? center.tabs : [];
  return center.tabs.filter((tab) => {
    if (['users', 'grants', 'audit'].includes(tab.name)) return user.isAdmin;
    if (['students', 'teachers'].includes(tab.name))
      return (
        user.isAdmin ||
        user.contestIds.some(
          (id) => user.permissions?.[id]?.includes('STUDENTS') ?? !user.permissions,
        )
      );
    return true;
  });
}

export function adminTabTarget(tab: string) {
  return adminCenters.find((center) => center.tabs.some((item) => item.name === tab))?.to;
}
