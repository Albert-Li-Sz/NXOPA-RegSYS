<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDown } from '@element-plus/icons-vue';
import { defaultSite } from '@contest-center/contracts';
import { api, auth } from './api';
import { setClientCsrf } from './generated-client';
import { mayLeaveEdits } from './composables/useEditSession';
import { adminLevelLabels } from '@contest-center/contracts';
import { adminCenters, centerTabs } from './admin-centers';
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
const brand = computed(() =>
  site.value.name.endsWith('在线报名系统')
    ? { name: site.value.name.slice(0, -6), subtitle: '在线报名系统' }
    : { name: site.value.name, subtitle: '在线报名系统' },
);
onMounted(async () => {
  try {
    site.value = await api('/site');
    document.title = site.value.name;
    document.documentElement.style.setProperty('--el-color-primary', site.value.primaryColor);
  } catch {}
});
async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    if (!(await mayLeaveEdits())) return;
    await api('/auth/logout', 'POST');
    auth.user = null;
    auth.csrf = '';
    setClientCsrf('');
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
    <header class="site-header" :inert="loggingOut || undefined">
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
          <router-link v-else to="/login"
            ><el-button type="primary" plain>登录 / 注册</el-button></router-link
          >
        </template>
      </div>
    </header>
    <main class="page" :inert="loggingOut || undefined">
      <router-view :key="$route.fullPath" />
    </main>
    <footer class="site-footer" :inert="loggingOut || undefined">
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
  </div>
</template>
