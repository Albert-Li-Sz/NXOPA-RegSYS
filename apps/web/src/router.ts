import { createRouter, createWebHistory } from 'vue-router';
import { auth, loadAuth } from './api';
import { adminCenters, centerTabs, adminTabTarget } from './admin-centers';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/Home.vue') },
    { path: '/overview', component: () => import('./pages/Overview.vue'), meta: { auth: true } },
    { path: '/contests', component: () => import('./pages/Contests.vue'), meta: { auth: true } },
    { path: '/contests/:id', component: () => import('./pages/Contest.vue'), meta: { auth: true } },
    { path: '/contests/:id/public-teams', component: () => import('./pages/PublicRoster.vue') },
    {
      path: '/me/profile',
      component: () => import('./pages/ProfileCenter.vue'),
      meta: { auth: true },
    },
    { path: '/me/files', component: () => import('./pages/MyFiles.vue'), meta: { auth: true } },
    {
      path: '/me/admissions',
      component: () => import('./pages/MyAdmissions.vue'),
      meta: { auth: true },
    },
    { path: '/login', component: () => import('./pages/Account.vue') },
    { path: '/account/:action?', component: () => import('./pages/Account.vue') },
    {
      path: '/registrations',
      component: () => import('./pages/MyRegistrations.vue'),
      meta: { auth: true },
    },
    {
      path: '/coach',
      component: () => import('./pages/MyRegistrations.vue'),
      meta: { auth: true },
    },
    {
      path: '/registrations/:id',
      component: () => import('./pages/Registration.vue'),
      meta: { auth: true },
    },
    { path: '/finance/:id', component: () => import('./pages/Finance.vue'), meta: { auth: true } },
    { path: '/invite/:token', component: () => import('./pages/Invite.vue'), meta: { auth: true } },
    { path: '/support/:id?', component: () => import('./pages/Support.vue'), meta: { auth: true } },
    ...adminCenters.map((center) => ({
      path: center.to,
      component: () => import('./pages/Admin.vue'),
      meta: { auth: true, adminCenter: center.key },
    })),
    {
      path: '/admin/contests/:id',
      component: () => import('./pages/ContestEditor.vue'),
      meta: { auth: true, adminCenter: 'contests' },
    },
    { path: '/:pathMatch(.*)*', component: () => import('./pages/NotFound.vue') },
  ],
});
router.beforeEach(async (to) => {
  if (!auth.loaded)
    try {
      await loadAuth();
    } catch {
      auth.loaded = true;
    }
  if (to.meta.auth && !auth.user) return { path: '/login', query: { next: to.fullPath } };
  if (to.path === '/admin') {
    const target = typeof to.query.tab === 'string' ? adminTabTarget(to.query.tab) : undefined;
    if (target && target !== to.path) return { path: target, query: to.query };
    if (!centerTabs('settings', auth.user).length && centerTabs('contests', auth.user).length)
      return '/admin/contests';
  }
  if (to.meta.adminCenter && !centerTabs(String(to.meta.adminCenter), auth.user).length)
    return '/contests';
});
