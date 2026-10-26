import {
  activityModulesSchema,
  contestStatus,
  registrationReviewPhase,
  type Principal,
} from '@contest-center/contracts';
import type { Registration } from './db.js';
import { canEdit, canActForApplicant, manages, owns } from './security.js';
export const modulesFor = (c: { modules: unknown }) => activityModulesSchema.parse(c.modules);
export function editingWindow(r: Registration, now = new Date()) {
  if (r.contest.archived || ['CANCELLED', 'CANCEL_REQUESTED'].includes(r.status)) return false;
  return (
    contestStatus(r.contest, now) === 'OPEN' ||
    (r.status === 'CORRECTION' && now < new Date(r.contest.correctionUntil ?? r.contest.closesAt))
  );
}
export function registrationDisplayState(r: { status: string; review: string }) {
  if (r.status === 'DRAFT') return 'DRAFT';
  if (r.status === 'CORRECTION') return 'CORRECTION';
  return r.review;
}
export function registrationEditAccess(u: Principal, r: Registration) {
  if (manages(u, r.contestId, 'REGISTRATIONS')) {
    if (r.contest.archived) return { allowed: false, reason: '活动已归档，报名管理只读' };
    const allowed =
      r.status === 'CORRECTION' || (r.status === 'SUBMITTED' && r.review === 'APPROVED');
    return { allowed, reason: allowed ? '' : '管理员仅可修改审核通过或待补正的报名' };
  }
  if (!editingWindow(r)) return { allowed: false, reason: '报名或补正时间已结束，或活动已归档' };
  return { allowed: canEdit(u, r), reason: canEdit(u, r) ? '' : '当前账号没有修改此报名的权限' };
}
export function registrationActions(u: Principal, r: Registration) {
  const open = editingWindow(r),
    access = registrationEditAccess(u, r),
    applicant = canActForApplicant(u, r),
    member = r.people.some((p) => p.active && p.userId && owns(u, p.userId)),
    manager = manages(u, r.contestId, 'REGISTRATIONS'),
    reviewPhase = registrationReviewPhase(r),
    reviewOpen = !r.contest.archived;
  return {
    edit: access.allowed,
    editOwnMember: member && (manager ? access.allowed : open),
    submit: applicant && open && ['DRAFT', 'CORRECTION'].includes(r.status),
    withdraw: applicant && open && reviewPhase === 'INITIAL' && !r.netPaidCents,
    cancel: owns(u, r.ownerId),
    delete: manager && !r.contest.archived,
    review: manager && reviewOpen && reviewPhase === 'INITIAL',
    amendReview: manager && reviewOpen && reviewPhase === 'AMEND',
    requestFinance: applicant,
    credentials: false,
    editReason: access.allowed
      ? ''
      : !manager && open && member
        ? '仅可修改本人信息'
        : access.reason,
  };
}
