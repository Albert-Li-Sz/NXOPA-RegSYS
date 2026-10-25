import {
  activityModulesSchema,
  contestStatus,
  policySchema,
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
export function registrationActions(u: Principal, r: Registration) {
  const open = editingWindow(r),
    editor = canEdit(u, r),
    applicant = canActForApplicant(u, r),
    member = r.people.some((p) => p.active && p.userId && owns(u, p.userId)),
    manager = manages(u, r.contestId, 'REGISTRATIONS'),
    reviewPhase = registrationReviewPhase(r),
    integrationManager = manages(u, r.contestId, 'INTEGRATIONS'),
    team = policySchema.parse(r.policySnapshot ?? r.contest.policy).mode === 'TEAM';
  return {
    edit: editor && open,
    editOwnMember: open && member,
    submit: applicant && open && ['DRAFT', 'CORRECTION'].includes(r.status),
    withdraw: applicant && open && reviewPhase === 'INITIAL' && !r.netPaidCents,
    cancel: owns(u, r.ownerId),
    delete: manager,
    review: manager && reviewPhase === 'INITIAL',
    amendReview: manager && reviewPhase === 'AMEND',
    requestFinance: applicant,
    credentials: false,
    editReason: open
      ? editor
        ? ''
        : member
          ? '仅可修改本人信息'
          : '当前账号没有修改此报名的权限'
      : '报名或补正时间已结束，或活动已归档',
  };
}
