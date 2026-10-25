<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, date } from '../api';
import type { Data } from '../types';
import PaginatedList from '../components/PaginatedList.vue';
const rows = ref<Data[]>([]),
  loading = ref(true),
  error = ref('');
onMounted(async () => {
  try {
    rows.value = await api('/admissions/mine');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '准考证加载失败';
  } finally {
    loading.value = false;
  }
});
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>我的准考证</h1>
      <p class="subtitle">查看个人和团队报名已发放的准考证</p>
    </div>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-skeleton
    v-if="loading"
    :rows="5"
    animated
  /><el-empty v-else-if="!rows.length" description="暂无已发放的准考证" />
  <PaginatedList :items="rows" page-key="my-admissions" v-slot="{ items }">
    <div v-for="row in items" :key="row.id" class="card member-heading">
      <div>
        <h3>{{ row.contestTitle }}</h3>
        <p class="muted">{{ row.name }} · {{ date(row.createdAt) }}</p>
        <router-link :to="`/registrations/${row.registrationId}`">查看报名</router-link>
      </div>
      <el-button
        tag="a"
        :href="`/api/v1/admissions/${row.id}/download`"
        target="_blank"
        rel="noopener"
        type="primary"
        plain
        >查看 / 下载</el-button
      >
    </div>
  </PaginatedList>
</template>
