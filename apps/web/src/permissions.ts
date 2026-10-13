import { auth } from './api';
import type { AdminPermission } from '@contest-center/contracts';
export function canManage(contestId: string, permission: AdminPermission = 'VIEW') {
  const user = auth.user;
  return (
    !!user &&
    (user.isAdmin ||
      (user.contestIds.includes(contestId) &&
        (user.permissions?.[contestId]?.includes(permission) ?? !user.permissions)))
  );
}
export function isSystemAdmin() {
  return !!(auth.user?.isSystemAdmin ?? auth.user?.isAdmin);
}
export function ownUser(id: string) {
  return !!auth.user && (auth.user.relatedUserIds ?? [auth.user.id]).includes(id);
}
