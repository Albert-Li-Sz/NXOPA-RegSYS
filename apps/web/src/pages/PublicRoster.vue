<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api, label } from '../api';
import type { Data } from '../types';
import ListPagination from '../components/ListPagination.vue';
const id = String(useRoute().params.id),
  contest = ref<Data>({}),
  rows = ref<Data[]>([]),
  total = ref(0),
  page = ref(1),
  size = ref(
    [20, 50, 100].includes(Number(localStorage.getItem('page-size:public-roster')))
      ? Number(localStorage.getItem('page-size:public-roster'))
      : 20,
  ),
  search = ref(''),
  loading = ref(false),
  error = ref('');
let sequence = 0;
async function refresh() {
  const current = ++sequence;
  loading.value = true;
  error.value = '';
  rows.value = [];
  total.value = 0;
  try {
    const data = await api(
      `/contests/${id}/public-teams?${new URLSearchParams({ page: String(page.value), pageSize: String(size.value), search: search.value })}`,
    );
    if (current !== sequence) return;
    contest.value = data.contest;
    rows.value = data.items;
    total.value = data.total;
    if (page.value > Math.max(1, Math.ceil(total.value / size.value)))
      page.value = Math.max(1, Math.ceil(total.value / size.value));
  } catch (e) {
    if (current === sequence) error.value = e instanceof Error ? e.message : '名单加载失败';
  } finally {
    if (current === sequence) loading.value = false;
  }
}
onMounted(refresh);
watch(page, refresh);
watch(size, (value) => {
  localStorage.setItem('page-size:public-roster', String(value));
  if (page.value !== 1) page.value = 1;
  else void refresh();
});
watch(search, () => {
  if (page.value !== 1) page.value = 1;
  else refresh();
});
</script>
<template>
  <p><router-link to="/contests">比赛列表</router-link> / 队伍公示</p>
  <div class="page-heading">
    <div>
      <h1>{{ contest.title || '队伍公示' }}</h1>
      <p class="subtitle">当前竞赛公开的参赛队伍，姓名加粗为队长</p>
    </div>
    <el-button
      v-if="!loading && !error && contest.id"
      tag="a"
      :href="`/api/v1/contests/${id}/public-teams/export`"
      type="primary"
      plain
      >导出名单</el-button
    >
  </div>
  <div class="toolbar">
    <el-input
      v-model="search"
      placeholder="搜索队名 / 英文队名"
      clearable
      aria-label="搜索公示队伍"
      style="max-width: 360px"
    />
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false">
    <el-button text @click="refresh">重新加载</el-button>
  </el-alert>
  <el-table :data="rows" v-loading="loading" stripe empty-text="暂无公示队伍">
    <el-table-column prop="teamName" label="队名" min-width="180" />
    <el-table-column prop="teamEnglishName" label="英文队名" min-width="180" />
    <el-table-column prop="school" label="学校" min-width="170" />
    <el-table-column prop="rank" label="网络赛排名" width="125" />
    <el-table-column label="队员" min-width="210"
      ><template #default="{ row }"
        ><template v-for="(member, index) in row.members" :key="index"
          ><span v-if="index"> / </span><strong v-if="member.captain">{{ member.name }}</strong
          ><span v-else>{{ member.name }}</span>
          <el-tag v-if="member.captain" size="small">队长</el-tag></template
        ></template
      ></el-table-column
    >
    <el-table-column label="指导老师" min-width="145"
      ><template #default="{ row }">{{ row.coaches.join(' / ') || '—' }}</template></el-table-column
    >
    <el-table-column label="审核状态" width="135"
      ><template #default="{ row }"
        ><el-tag :type="row.review === 'APPROVED' ? 'success' : 'warning'">{{
          label(row.review)
        }}</el-tag></template
      ></el-table-column
    >
    <el-table-column label="参赛性质" width="130"
      ><template #default="{ row }">{{ label(row.participationType) }}</template></el-table-column
    >
  </el-table>
  <ListPagination v-model:page="page" v-model:size="size" :total="total" :loading="loading" />
</template>
