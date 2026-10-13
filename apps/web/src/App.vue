<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDown } from '@element-plus/icons-vue';
import { defaultSite } from '@contest-center/contracts';
import { api, auth, loadAuth } from './api';
import PersonalShell from './components/PersonalShell.vue';
import { adminLevelLabels } from '@contest-center/contracts';
const router = useRouter();
const route = useRoute();
const personal = computed(
  () =>
    !!auth.user &&
    (route.path.startsWith('/me/') || route.path === '/registrations' || route.path === '/account'),
);
const isLanding = computed(() => route.path === '/');
const site = ref({ ...defaultSite });
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
  await api('/auth/logout', 'POST');
  await loadAuth();
  router.push('/');
}
</script>
<template>
  <div class="site-shell" :class="{ 'landing-shell': isLanding }">
    <header class="site-header">
      <div class="header-inner">
        <router-link to="/" class="brand" :aria-label="site.name">
          <img class="brand-logo" src="/brand/openatom-club.jpg" width="42" height="42" alt="" />
          <span class="brand-copy"
            ><strong>{{ brand.name }}</strong
            ><small>{{ brand.subtitle }}</small></span
          >
        </router-link>
        <template v-if="!isLanding">
          <nav aria-label="主导航">
            <router-link to="/">首页</router-link><router-link to="/contests">竞赛</router-link
            ><router-link to="/registrations">我的报名</router-link
            ><router-link v-if="auth.user?.isCoach" to="/coach">指导老师</router-link
            ><router-link to="/support">工单</router-link
            ><router-link
              v-if="auth.user && (auth.user.isAdmin || auth.user.contestIds.length)"
              to="/admin"
              >管理中心</router-link
            >
          </nav>
          <div class="header-account" v-if="auth.user">
            <span class="role-pill" v-if="auth.user.adminLevel">{{
              adminLevelLabels[auth.user.adminLevel]
            }}</span
            ><span class="role-pill" v-else-if="auth.user.isCoach">指导老师</span
            ><el-dropdown
              ><button class="user-menu">
                <span class="avatar">{{ auth.user.name.slice(0, 1) }}</span
                ><span class="user-name" :title="auth.user.name">{{ auth.user.name }}</span
                ><el-icon><ArrowDown /></el-icon></button
              ><template #dropdown
                ><el-dropdown-menu
                  ><el-dropdown-item @click="router.push('/me/profile')">个人中心</el-dropdown-item
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
    <main class="page">
      <PersonalShell v-if="personal"><router-view :key="$route.fullPath" /></PersonalShell
      ><router-view v-else :key="$route.fullPath" />
    </main>
    <footer class="site-footer">
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
