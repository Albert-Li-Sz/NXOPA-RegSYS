<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, auth, date, money, label } from '../api';
import type { ContestView, RegistrationView } from '../types';
const route = useRoute(),
  router = useRouter();
const c = ref<ContestView>(),
  registrations = ref<RegistrationView[]>([]),
  tab = ref('info'),
  busy = ref(false),
  error = ref('');
onMounted(async () => {
  try {
    c.value = await api(`/contests/${route.params.id}`);
    if (auth.user) registrations.value = await api(`/registrations?contestId=${route.params.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '竞赛无法加载';
  }
});
async function create() {
  if (!auth.user) {
    router.push({ path: '/login', query: { next: route.fullPath } });
    return;
  }
  busy.value = true;
  try {
    const r = await api<RegistrationView>('/registrations', 'POST', { contestId: c.value!.id });
    router.push(`/registrations/${r.id}`);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-result v-if="error" icon="warning" title="竞赛无法加载" :sub-title="error" /><el-skeleton
    v-else-if="!c"
    :rows="8"
    animated
  /><template v-else>
    <div class="crumb">
      <router-link to="/">比赛列表</router-link><span>/</span><span>竞赛报名</span>
    </div>
    <h1 class="detail-title">{{ c.title }}</h1>
    <p class="subtitle">比赛时间：{{ date(c.startsAt) }}</p>
    <el-tabs v-model="tab" style="margin-top: 20px">
      <el-tab-pane label="信息" name="info"
        ><div class="panel">
          <div class="card season-info">
            <h3>竞赛信息</h3>
            <div class="info-row">
              <span class="muted">当前赛季</span><span>{{ c.season }}</span>
            </div>
            <div class="info-row">
              <span class="muted">报名形式</span
              ><span>{{
                c.policy.mode === 'TEAM'
                  ? `团队报名 · ${c.policy.minMembers}–${c.policy.maxMembers} 人`
                  : '个人报名'
              }}</span>
            </div>
            <div class="info-row">
              <span class="muted">费用</span
              ><span>{{ c.policy.feeMode === 'FREE' ? '免费' : money(c.policy.feeCents) }}</span>
            </div>
            <div class="info-row">
              <span class="muted">指导老师</span
              ><span>{{
                c.policy.coachMode === 'REQUIRED'
                  ? '必须关联'
                  : c.policy.coachMode === 'OPTIONAL'
                    ? '可选'
                    : '不设指导老师'
              }}</span>
            </div>
          </div>
          <div class="two-columns">
            <div>
              <div class="card">
                <h3>公告</h3>
                <div class="pre-line">{{ c.announcement || '暂无公告' }}</div>
              </div>
              <div class="card">
                <h3>竞赛介绍</h3>
                <div class="pre-line">{{ c.description }}</div>
              </div>
            </div>
            <aside class="card">
              <h3>时间线</h3>
              <el-timeline
                ><el-timeline-item type="success" :timestamp="date(c.opensAt)"
                  >报名开始</el-timeline-item
                ><el-timeline-item type="danger" :timestamp="date(c.closesAt)"
                  >报名截止</el-timeline-item
                ><el-timeline-item type="primary" :timestamp="date(c.startsAt)"
                  >正式比赛</el-timeline-item
                ></el-timeline
              ><el-button
                type="primary"
                style="width: 100%"
                :disabled="c.status !== 'OPEN'"
                :loading="busy"
                @click="create"
                >{{
                  c.status === 'OPEN'
                    ? '立即报名'
                    : c.status === 'UPCOMING'
                      ? '即将开放'
                      : '报名已关闭'
                }}</el-button
              >
            </aside>
          </div>
        </div></el-tab-pane
      >
      <el-tab-pane :label="c.policy.mode === 'TEAM' ? '队伍' : '报名'" name="registrations"
        ><div class="panel">
          <div class="actions">
            <el-button type="primary" :disabled="c.status !== 'OPEN'" @click="create"
              >创建报名</el-button
            ><router-link
              v-if="auth.user && (auth.user.isAdmin || auth.user.contestIds.includes(c.id))"
              :to="`/admin/contests/${c.id}`"
              ><el-button>管理竞赛</el-button></router-link
            >
          </div>
          <el-empty v-if="!registrations.length" description="您尚未报名此竞赛" />
          <div v-for="r in registrations" :key="r.id" class="card">
            <div class="member-heading">
              <h3>
                {{ r.teamName || r.people[0]?.name || '个人报名' }}
                <el-tag>{{ label(r.status) }}</el-tag>
              </h3>
              <router-link :to="`/registrations/${r.id}`"
                ><el-button type="primary" plain>查看报名</el-button></router-link
              >
            </div>
            <p class="muted">
              {{ r.people.map((p) => p.name).join('、') }} · {{ label(r.review) }}
            </p>
          </div>
        </div></el-tab-pane
      >
      <el-tab-pane label="准考证" name="admissions"
        ><div class="panel">
          <el-empty v-if="!registrations.length" description="报名后可在此查看准考证" />
          <p v-else class="notice">准考证按报名单位发放，请进入对应报名查看与下载。</p>
          <div class="actions">
            <router-link
              v-for="r in registrations"
              :key="r.id"
              :to="`/registrations/${r.id}?tab=admissions`"
              ><el-button>{{ r.teamName || r.people[0]?.name }} · 准考证</el-button></router-link
            >
          </div>
        </div></el-tab-pane
      >
      <el-tab-pane label="财务" name="finance"
        ><div class="panel">
          <div v-if="c.policy.feeMode === 'FREE'" class="card">
            <h3>免费竞赛</h3>
            <p class="muted">本竞赛无需缴纳报名费用。</p>
          </div>
          <template v-else
            ><div class="notice pre-line">
              {{ c.policy.paymentInstructions || '请查看公告中的线下收款说明。' }}
            </div>
            <div class="actions">
              <router-link
                v-for="r in registrations"
                :key="r.id"
                :to="`/registrations/${r.id}?tab=finance`"
                ><el-button
                  >{{ r.teamName || r.people[0]?.name }} · 缴费记录</el-button
                ></router-link
              >
            </div></template
          >
        </div></el-tab-pane
      >
      <el-tab-pane label="工单" name="support"
        ><div class="card">
          <h3>遇到报名问题？</h3>
          <p class="muted">提交工单，竞赛管理员将协助处理。</p>
          <router-link :to="`/support?contestId=${c.id}`"
            ><el-button type="primary" plain>提交竞赛工单</el-button></router-link
          >
        </div></el-tab-pane
      >
    </el-tabs>
  </template>
</template>
<style scoped>
.season-info {
  margin-bottom: 20px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  line-height: 2.2;
  font-size: 14px;
}
</style>
