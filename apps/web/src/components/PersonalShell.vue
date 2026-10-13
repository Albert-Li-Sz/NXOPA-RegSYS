<script setup lang="ts">
import { useRoute } from 'vue-router';
import { User, Monitor, Tickets, FolderOpened, ArrowLeft } from '@element-plus/icons-vue';
const route = useRoute();
const links = [
  { to: '/me/profile', label: '个人信息', icon: User },
  { to: '/registrations', label: '我的报名', icon: Monitor },
  { to: '/me/admissions', label: '我的准考证', icon: Tickets },
  { to: '/me/files', label: '我的附件', icon: FolderOpened },
];
</script>
<template>
  <div class="personal-shell">
    <aside class="personal-nav" aria-label="个人中心导航">
      <router-link to="/contests"
        ><el-icon><ArrowLeft /></el-icon>返回竞赛</router-link
      >
      <router-link
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :class="{
          selected:
            route.path === link.to || (link.to === '/me/profile' && route.path === '/account'),
        }"
        ><el-icon><component :is="link.icon" /></el-icon>{{ link.label }}</router-link
      >
    </aside>
    <section class="personal-content"><slot /></section>
  </div>
</template>
<style scoped>
.personal-shell {
  display: grid;
  grid-template-columns: 205px minmax(0, 1fr);
  gap: 30px;
}
.personal-nav {
  border-right: 1px solid #ebeef2;
  padding-right: 20px;
}
.personal-nav a {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px;
  margin-bottom: 7px;
  color: #606266;
  border-radius: 0 26px 26px 0;
}
.personal-nav .selected,
.personal-nav .router-link-exact-active {
  background: var(--el-color-primary);
  color: white;
}
.personal-content {
  min-width: 0;
}
@media (max-width: 760px) {
  .personal-shell {
    grid-template-columns: minmax(0, 1fr);
    gap: 22px;
  }
  .personal-nav {
    display: flex;
    flex-wrap: wrap;
    border-right: 0;
    border-bottom: 1px solid #ebeef2;
    padding: 0 0 10px;
    gap: 6px;
  }
  .personal-nav a {
    padding: 9px 12px;
    font-size: 13px;
    margin: 0;
    border-radius: 20px;
  }
}
</style>
