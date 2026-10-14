<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import ListPagination from '../components/ListPagination.vue';
import { usePagedList } from '../composables/usePagedList';
import { api, auth, label } from '../api';
import type { RegistrationView } from '../types';
const list = usePagedList<RegistrationView>('my-registrations', () =>
  route.path === '/coach' ? '/registrations?role=coach' : '/registrations?role=mine',
);
const summary = ref({ total: 0, pending: 0, eligible: 0, correction: 0 }),
  summaryError = ref('');
const route = useRoute(),
  rows = list.items,
  link = ref(''),
  loading = ref(true);
const coach = computed(() => route.path === '/coach');
const filtered = computed(() => rows.value);
let summarySequence = 0;
async function refreshSummary() {
  const sequence = ++summarySequence;
  try {
    const query = [coach.value ? 'role=coach' : 'role=mine', list.query(false)]
      .filter(Boolean)
      .join('&');
    const value = await api(`/registrations/summary?${query}`);
    if (sequence === summarySequence) {
      summary.value = value;
      summaryError.value = '';
    }
  } catch (e) {
    if (sequence === summarySequence)
      summaryError.value = e instanceof Error ? e.message : '报名统计加载失败';
  }
}
watch(list.filters, refreshSummary, { deep: true });
onMounted(async () => {
  try {
    await Promise.all([list.load(), refreshSummary()]);
  } finally {
    loading.value = false;
  }
});
async function copyLink() {
  await navigator.clipboard.writeText(link.value);
}
async function createLink() {
  link.value = (await api('/coach/links', 'POST', { kind: 'COACH_LINK' })).url;
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>{{ coach ? '指导老师中心' : '我的报名' }}</h1>
      <p class="subtitle">
        {{ coach ? '协助参赛者完善资料，跟进审核与缴费' : '管理您的个人报名、团队与参赛进度' }}
      </p>
    </div>
    <el-button v-if="coach" type="primary" plain @click="createLink">创建老师关联链接</el-button
    ><router-link v-else to="/contests"><el-button type="primary">浏览竞赛</el-button></router-link>
  </div>
  <div v-if="link" class="card">
    <h3>分享关联链接</h3>
    <p class="muted">参赛者登录后选择自己的报名，即可确认指导关系。</p>
    <div class="copy-link">
      <el-input :model-value="link" readonly /><el-button @click="copyLink">复制</el-button>
    </div>
  </div>
  <el-alert v-if="list.error.value" :title="list.error.value" type="error" :closable="false" />
  <el-alert v-if="summaryError" :title="summaryError" type="error" :closable="false"
    ><el-button @click="refreshSummary">重新加载</el-button></el-alert
  >
  <el-skeleton v-if="loading" :rows="8" animated /><template v-else
    ><div class="stats">
      <div class="stat">
        <span>报名总数</span>
        <div class="value">{{ summary.total }}</div>
        <span class="hint">个人与团队报名</span>
      </div>
      <div class="stat">
        <span>等待审核</span>
        <div class="value" style="color: #d69b18">
          {{ summary.pending }}
        </div>
        <span class="hint">已提交的报名</span>
      </div>
      <div class="stat">
        <span>取得资格</span>
        <div class="value" style="color: #12a875">
          {{ summary.eligible }}
        </div>
        <span class="hint">资料、审核与缴费完成</span>
      </div>
      <div class="stat">
        <span>待补正</span>
        <div class="value" style="color: #e45656">
          {{ summary.correction }}
        </div>
        <span class="hint">请查看管理员意见</span>
      </div>
    </div>
    <div class="toolbar">
      <el-input
        v-model="list.filters.value.search"
        clearable
        placeholder="搜索竞赛、队名或姓名"
        style="max-width: 360px"
      /><el-select v-model="list.filters.value.review" clearable placeholder="审核状态" filterable
        ><el-option
          v-for="state in ['PENDING', 'APPROVED', 'CORRECTION', 'REJECTED']"
          :key="state"
          :value="state"
          :label="label(state)"
      /></el-select>
    </div>
    <div class="toolbar">
      <el-date-picker
        v-model="list.filters.value.from"
        type="datetime"
        value-format="YYYY-MM-DDTHH:mm:ssZ"
        placeholder="开始时间"
      /><el-date-picker
        v-model="list.filters.value.to"
        type="datetime"
        value-format="YYYY-MM-DDTHH:mm:ssZ"
        placeholder="结束时间"
      />
    </div>
    <el-empty
      v-if="!filtered.length"
      :description="
        list.filters.value.search || list.filters.value.review
          ? '没有符合筛选条件的报名'
          : coach
            ? '尚无关联报名'
            : '您还没有报名竞赛'
      "
    />
    <div v-for="r in filtered" :key="r.id" class="card">
      <div class="member-heading">
        <div>
          <h3 style="margin-bottom: 8px">
            <el-tag v-if="r.number" type="info">报名 #{{ r.number }}</el-tag>
            {{ r.teamName || r.people[0]?.name }}
            <el-tag :type="r.eligible ? 'success' : 'info'">{{
              r.eligible ? '参赛资格已确认' : label(r.status)
            }}</el-tag>
          </h3>
          <router-link :to="`/contests/${r.contestId}`">{{ r.contest.title }}</router-link>
        </div>
        <router-link :to="`/registrations/${r.id}`"
          ><el-button type="primary" plain>查看 / 编辑</el-button></router-link
        >
      </div>
      <p class="muted">{{ r.people.map((p) => p.name).join('、') }} · {{ label(r.review) }}</p>
    </div></template
  >
  <ListPagination
    v-model:page="list.page.value"
    v-model:size="list.pageSize.value"
    :total="list.total.value"
    :loading="list.loading.value"
  />
</template>
