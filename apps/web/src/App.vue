<script setup lang="ts">
import { ref, computed, onMounted, onScopeDispose } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import { ArrowDown } from '@element-plus/icons-vue';
import { defaultSite } from '@contest-center/contracts';
import { api, auth, loadAuth } from './api';
import { confirmLeaveEdits, discardEdits } from './composables/useEditSession';
import { adminLevelLabels } from '@contest-center/contracts';
import { adminCenters, centerTabs } from './admin-centers';
import { hasPendingOperations } from './composables/usePendingOperations';
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (hasPendingOperations.value) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
onScopeDispose(() => window.removeEventListener('beforeunload', beforeUnload));
const router = useRouter();
const route = useRoute();
const visibleCenters = computed(() =>
  adminCenters.filter((center) => centerTabs(center.key, auth.user).length),
);
const isLanding = computed(() => route.path === '/');
const displayName = computed(() => {
  const nickname = auth.user?.profile.display_name;
  return typeof nickname === 'string' && nickname.trim() ? nickname : auth.user?.name || '';
});
const site = ref({ ...defaultSite });
const loggingOut = ref(false);
const recoveryPassword = ref(''),
  recovering = ref(false),
  recoveryError = ref('');
async function recoverSession(passwordLogin = true) {
  if (recovering.value || !auth.expiredUser) return;
  recovering.value = true;
  recoveryError.value = '';
  try {
    if (passwordLogin) {
      const current = await api<{ csrf: string }>('/auth/me');
      auth.csrf = current.csrf;
      await api('/auth/login', 'POST', {
        account: auth.expiredUser.email,
        password: recoveryPassword.value,
      });
    }
    await loadAuth();
    recoveryPassword.value = '';
  } catch (error) {
    recoveryError.value = error instanceof Error ? error.message : '恢复登录失败';
  } finally {
    recovering.value = false;
  }
}
async function leaveExpiredSession() {
  if (!(await confirmLeaveEdits())) return;
  discardEdits();
  auth.expiredUser = null;
  auth.loaded = false;
  recoveryPassword.value = '';
  await router.replace({ path: '/login', query: { next: route.fullPath } });
}
const brand = computed(() =>
  site.value.name.endsWith('在线报名系统')
    ? { name: site.value.name.slice(0, -6), subtitle: '在线报名系统' }
    : { name: site.value.name, subtitle: '在线报名系统' },
);
onMounted(async () => {
  try {
    site.value = await api('/site');
    document.title = site.value.name;
    let rgb = [1, 3, 5].map((i) => parseInt(site.value.primaryColor.slice(i, i + 2), 16));
    const luminance = () =>
      rgb
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    while (luminance() > 0.16) rgb = rgb.map((v) => Math.floor(v * 0.9));
    const color = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
    document.documentElement.style.setProperty('--el-color-primary', color);
    document.documentElement.style.setProperty(
      '--el-color-primary-light-3',
      '#' +
        rgb
          .map((v) =>
            Math.floor(v * 0.9)
              .toString(16)
              .padStart(2, '0'),
          )
          .join(''),
    );
    document.documentElement.style.setProperty(
      '--el-color-primary-dark-2',
      '#' +
        rgb
          .map((v) =>
            Math.floor(v * 0.8)
              .toString(16)
              .padStart(2, '0'),
          )
          .join(''),
    );
  } catch {}
});
async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    if (!(await confirmLeaveEdits())) return;
    await api('/auth/logout', 'POST');
    discardEdits();
    auth.user = null;
    auth.csrf = '';
    await router.replace('/');
  } catch {
    // API failures already display an error; keep the current session available for retry.
  } finally {
    loggingOut.value = false;
  }
}
</script>
<template>
  <div class="site-shell" :class="{ 'landing-shell': isLanding }" :aria-busy="loggingOut">
    <header class="site-header" :inert="loggingOut || !!auth.expiredUser || undefined">
      <div
        class="header-inner"
        :class="{ 'admin-header': visibleCenters.length > 0 && !isLanding }"
      >
        <router-link to="/" class="brand" :aria-label="site.name">
          <img class="brand-logo" src="/brand/openatom-club.jpg" width="42" height="42" alt="" />
          <span class="brand-copy"
            ><strong>{{ brand.name }}</strong
            ><small>{{ brand.subtitle }}</small></span
          >
        </router-link>
        <template v-if="!isLanding">
          <nav aria-label="主导航">
            <router-link to="/overview">活动总览</router-link
            ><router-link to="/contests">活动及竞赛中心</router-link
            ><router-link to="/registrations">我的报名</router-link
            ><router-link to="/me/admissions">我的准考证</router-link
            ><router-link to="/me/files">我的附件</router-link
            ><router-link v-if="auth.user?.isCoach" to="/coach">指导老师</router-link
            ><router-link to="/support">工单</router-link
            ><router-link
              v-for="center in visibleCenters"
              :key="center.key"
              :to="center.to"
              :class="{ selected: route.meta.adminCenter === center.key }"
              :active-class="'admin-link-active'"
              >{{ center.label }}</router-link
            >
          </nav>
          <div class="header-account" v-if="auth.user">
            <span class="role-pill" v-if="auth.user.adminLevel">{{
              adminLevelLabels[auth.user.adminLevel]
            }}</span
            ><span class="role-pill" v-else-if="auth.user.isCoach">指导老师</span
            ><el-dropdown trigger="click"
              ><button class="user-menu">
                <span class="avatar">{{ displayName.slice(0, 1) }}</span
                ><span class="user-name" :title="displayName">{{ displayName }}</span
                ><el-icon><ArrowDown /></el-icon></button
              ><template #dropdown
                ><el-dropdown-menu
                  ><el-dropdown-item @click="router.push('/me/profile')">个人信息</el-dropdown-item
                  ><el-dropdown-item @click="logout">退出登录</el-dropdown-item></el-dropdown-menu
                ></template
              ></el-dropdown
            >
          </div>
          <el-button :tag="RouterLink" v-else to="/login" type="primary" plain
            >登录 / 注册</el-button
          >
        </template>
      </div>
    </header>
    <main class="page" :inert="loggingOut || !!auth.expiredUser || undefined">
      <router-view :key="$route.fullPath" />
    </main>
    <footer class="site-footer" :inert="loggingOut || !!auth.expiredUser || undefined">
      <div class="footer-brand">
        <img src="/brand/openatom-club.jpg" width="30" height="30" alt="" />
        <div>
          <strong>{{ site.name }}</strong
          ><span>{{ site.footer }}</span>
        </div>
      </div>
      <div class="footer-links">
        <router-link to="/contests">竞赛报名</router-link
        ><router-link to="/account">账号中心</router-link
        ><router-link to="/support">工单中心</router-link>
      </div>
      <div class="footer-note">
        <span>开放 · 协作 · 探索</span><span>© {{ new Date().getFullYear() }} 南晓开放原子社</span>
      </div>
    </footer>
    <el-dialog
      :model-value="!!auth.expiredUser"
      title="登录已失效"
      width="min(440px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
    >
      <p>当前草稿已保留，请使用原账号重新登录后继续编辑。</p>
      <el-form class="session-recovery-form" @submit.prevent="recoverSession()">
        <el-form-item label="账号"
          ><el-input :model-value="auth.expiredUser?.email" readonly
        /></el-form-item>
        <el-form-item label="密码"
          ><el-input
            v-model="recoveryPassword"
            aria-label="恢复登录密码"
            type="password"
            show-password
            autocomplete="current-password"
        /></el-form-item>
        <el-alert v-if="recoveryError" :title="recoveryError" type="error" :closable="false" />
        <el-button type="primary" native-type="submit" :loading="recovering"
          >重新登录并继续</el-button
        >
      </el-form>
      <p><a href="/login" target="_blank" rel="noopener">在新窗口使用其他登录方式</a></p>
      <div class="button-group session-recovery-actions">
        <el-button :disabled="recovering" @click="recoverSession(false)"
          >已登录，恢复编辑</el-button
        >
        <el-button :disabled="recovering" @click="leaveExpiredSession"
          >放弃草稿并前往登录</el-button
        >
      </div>
    </el-dialog>
  </div>
</template>
