<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import ListPagination from './ListPagination.vue';
import { useLocalPagination } from '../composables/useLocalPagination';
import { Calendar, User, Search } from '@element-plus/icons-vue';
import { shortDate, date, money } from '../api';
import { useRoute } from 'vue-router';
import type { ContestView } from '../types';
const props = withDefaults(
  defineProps<{ contests: ContestView[]; loading: boolean; error: string; headingLevel?: 1 | 2 }>(),
  { headingLevel: 1 },
);
const emit = defineEmits<{ retry: [] }>();
const filter = ref(String(useRoute().query.status ?? 'ALL')),
  search = ref(''),
  season = ref('');
const statuses = [
  { label: '全部竞赛', value: 'ALL' },
  { label: '开放报名', value: 'OPEN' },
  { label: '即将开始', value: 'UPCOMING' },
  { label: '报名关闭', value: 'CLOSED' },
];
const filtered = computed(() =>
  props.contests.filter(
    (c) =>
      (filter.value === 'ALL' || c.status === filter.value) &&
      (!season.value || c.season === season.value) &&
      c.title.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const seasons = computed(() => [...new Set(props.contests.map((c) => c.season))]);
const list = useLocalPagination('contest-catalogue', () => filtered.value);
watch([filter, search, season], list.reset);
</script>
<template>
  <div class="page-heading">
    <div>
      <component :is="headingLevel === 1 ? 'h1' : 'h2'" class="catalogue-title">比赛列表</component>
      <p class="subtitle">发现竞赛，管理您的报名与队伍</p>
    </div>
    <span class="compact-label">共 {{ contests.length }} 项竞赛</span>
  </div>
  <div class="toolbar">
    <span class="filter-label">比赛筛选：</span
    ><el-segmented v-model="filter" :options="statuses" /><el-input
      v-model="search"
      :prefix-icon="Search"
      placeholder="搜索竞赛名称"
      clearable
      aria-label="搜索竞赛"
    /><el-select v-model="season" placeholder="全部赛季" clearable style="width: 145px" filterable
      ><el-option v-for="s in seasons" :label="`${s} 赛季`" :value="s" :key="s"
    /></el-select>
  </div>
  <el-skeleton v-if="loading" :rows="8" animated />
  <div v-else-if="error" class="error-state">
    加载失败 <el-button text @click="emit('retry')">重试</el-button>
  </div>
  <el-empty v-else-if="!filtered.length" description="暂时没有符合条件的竞赛" />
  <section v-else class="contest-grid" aria-label="竞赛列表">
    <article v-for="c in list.items.value" :key="c.id" class="contest-card">
      <div class="card-tags">
        <el-tag effect="dark" round
          ><el-icon><User /></el-icon
          >{{ c.policy.mode === 'TEAM' ? '团队报名' : '个人报名' }}</el-tag
        ><el-tag
          :type="c.status === 'OPEN' ? 'primary' : c.status === 'UPCOMING' ? 'warning' : 'info'"
          effect="light"
          round
          >{{
            c.status === 'OPEN' ? '报名中' : c.status === 'UPCOMING' ? '即将开始' : '已关闭'
          }}</el-tag
        >
      </div>
      <h2>{{ c.title }}</h2>
      <div class="contest-meta">
        <p>
          <el-icon><Calendar /></el-icon><span>比赛日期： {{ shortDate(c.startsAt) }}</span>
        </p>
        <p>
          <el-icon><Calendar /></el-icon><span>报名开始： {{ date(c.opensAt) }}</span>
        </p>
        <p>
          <el-icon><Calendar /></el-icon><span>报名截止： {{ date(c.closesAt) }}</span>
        </p>
      </div>
      <div class="contest-bottom">
        <span>{{
          c.policy.feeMode === 'FREE'
            ? '免费竞赛'
            : `${money(c.policy.feeCents)} / ${c.policy.feeMode === 'PER_PERSON' ? '人' : '份报名'}`
        }}</span
        ><span>{{
          c.policy.mode === 'TEAM'
            ? `${c.policy.minMembers === c.policy.maxMembers ? c.policy.minMembers : `${c.policy.minMembers}–${c.policy.maxMembers}`} 人团队`
            : '独立参赛'
        }}</span>
      </div>
      <div class="contest-actions">
        <router-link :to="`/contests/${c.id}`" class="el-button el-button--primary view-button"
          >查看竞赛 <span class="view-arrow" aria-hidden="true">&gt;&gt;</span></router-link
        >
        <router-link
          v-if="c.publicRosterEnabled"
          :to="`/contests/${c.id}/public-teams`"
          class="el-button view-button"
          >队伍公示</router-link
        >
      </div>
    </article>
  </section>
  <ListPagination
    v-if="!loading && !error"
    v-model:page="list.page.value"
    v-model:size="list.pageSize.value"
    :total="list.total.value"
  />
</template>
<style scoped>
.catalogue-title {
  font-size: 26px;
  margin: 0 0 8px;
  font-weight: 650;
}
@media (max-width: 760px) {
  .catalogue-title {
    font-size: 23px;
  }
}
.contest-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 26px;
}
.contest-card {
  border: 1px solid #ebeef2;
  border-radius: 9px;
  padding: 23px;
  box-shadow: 0 2px 4px #1f293705;
  transition: box-shadow 0.15s;
}
.contest-card:hover {
  box-shadow: 0 5px 20px #1f29370d;
}
.card-tags {
  display: flex;
  justify-content: space-between;
}
.card-tags .el-icon {
  margin-right: 4px;
}
.contest-card h2 {
  font-size: 18px;
  line-height: 1.65;
  margin: 22px 0 19px;
  min-height: 30px;
}
.contest-meta p {
  display: flex;
  align-items: center;
  gap: 11px;
  color: #626b78;
  font-size: 15px;
  margin: 12px 0;
}
.contest-bottom {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #626b78;
  margin: 20px 0 17px;
}
.contest-actions {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 10px;
}
.contest-actions .view-button {
  width: 100%;
  min-width: 0;
  height: 39px;
  margin: 0;
  font-size: 15px;
}
.view-arrow {
  margin-left: 8px;
}
.filter-label {
  color: #606266;
}
.toolbar {
  margin: 24px 0 27px;
}
.el-segmented {
  --el-segmented-bg-color: #f0f3f5;
  --el-segmented-item-selected-bg-color: white;
  --el-segmented-item-selected-color: #303133;
  padding: 5px;
}
@media (max-width: 760px) {
  .contest-grid {
    grid-template-columns: 1fr;
    gap: 18px;
  }
  .contest-card {
    padding: 20px;
  }
  .filter-label {
    display: none;
  }
  .el-segmented {
    width: 100%;
  }
  .contest-meta {
    font-size: 13px;
  }
  .contest-card h2 {
    font-size: 17px;
  }
}
</style>
