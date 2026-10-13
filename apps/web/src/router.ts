import { createRouter, createWebHistory } from 'vue-router';
import { auth, loadAuth } from './api';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/Home.vue') },
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
    { path: '/invite/:token', component: () => import('./pages/Invite.vue'), meta: { auth: true } },
    { path: '/support/:id?', component: () => import('./pages/Support.vue'), meta: { auth: true } },
    { path: '/admin', component: () => import('./pages/Admin.vue'), meta: { auth: true } },
    {
      path: '/admin/contests/:id',
      component: () => import('./pages/ContestEditor.vue'),
      meta: { auth: true },
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
});
