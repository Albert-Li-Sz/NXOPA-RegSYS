<script setup lang="ts">
import { ref, shallowRef, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api, auth, label } from '../api';
import type { RegistrationView } from '../types';
const route = useRoute(),
  rows = shallowRef<RegistrationView[]>([]),
  link = ref(''),
  loading = ref(true);
const coach = computed(() => route.path === '/coach');
const filtered = computed(() =>
  coach.value
    ? rows.value.filter((r) => r.coaches.some((c) => c.userId === auth.user?.id))
    : rows.value,
);
onMounted(async () => {
  try {
    rows.value = await api('/registrations');
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
    ><router-link v-else to="/"><el-button type="primary">浏览竞赛</el-button></router-link>
  </div>
  <div v-if="link" class="card">
    <h3>分享关联链接</h3>
    <p class="muted">参赛者登录后选择自己的报名，即可确认指导关系。</p>
    <div class="copy-link">
      <el-input :model-value="link" readonly /><el-button @click="copyLink">复制</el-button>
    </div>
  </div>
  <el-skeleton v-if="loading" :rows="8" animated /><el-empty
    v-else-if="!filtered.length"
    :description="coach ? '尚无关联报名' : '您还没有报名竞赛'"
  /><template v-else
    ><div class="stats">
      <div class="stat">
        <span>报名总数</span>
        <div class="value">{{ filtered.length }}</div>
        <span class="hint">个人与团队报名</span>
      </div>
      <div class="stat">
        <span>等待审核</span>
        <div class="value" style="color: #d69b18">
          {{ filtered.filter((x) => x.status === 'SUBMITTED' && x.review === 'PENDING').length }}
        </div>
        <span class="hint">已提交的报名</span>
      </div>
      <div class="stat">
        <span>取得资格</span>
        <div class="value" style="color: #12a875">
          {{ filtered.filter((x) => x.eligible).length }}
        </div>
        <span class="hint">资料、审核与缴费完成</span>
      </div>
      <div class="stat">
        <span>待补正</span>
        <div class="value" style="color: #e45656">
          {{ filtered.filter((x) => x.status === 'CORRECTION').length }}
        </div>
        <span class="hint">请查看管理员意见</span>
      </div>
    </div>
    <div v-for="r in filtered" :key="r.id" class="card">
      <div class="member-heading">
        <div>
          <h3 style="margin-bottom: 8px">
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
</template>
