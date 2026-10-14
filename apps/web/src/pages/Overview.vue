<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, date } from '../api';
import type { Data } from '../types';

const data = ref<Data>(),
  selected = ref(''),
  loading = ref(false),
  error = ref(''),
  now = ref(new Date()),
  screen = ref<HTMLElement>();
let sequence = 0,
  refreshTimer: ReturnType<typeof setInterval>,
  clockTimer: ReturnType<typeof setInterval>;
const totals = computed(() => data.value?.totals ?? {});
const phases: Record<string, string> = { OPEN: '报名中', UPCOMING: '即将开放', CLOSED: '报名结束' };
const bars = computed(() =>
  [...(data.value?.activities ?? [])].sort((a, b) => b.active - a.active).slice(0, 8),
);
const max = computed(() => Math.max(1, ...bars.value.map((c) => c.active)));
const approvalPercent = computed(() =>
  totals.value.active ? Math.round((100 * totals.value.approved) / totals.value.active) : 0,
);
const metrics = computed(() => [
  {
    name: '活动总数',
    value: totals.value.activities,
    hint: `${totals.value.openActivities ?? 0} 场正在报名`,
    color: 'cyan',
  },
  {
    name: '累计提交报名',
    value: totals.value.submitted,
    hint: '包括已取消的历史提交',
    color: 'blue',
  },
  {
    name: '当前有效报名',
    value: totals.value.active,
    hint: `${totals.value.unofficial ?? 0} 份非正式报名`,
    color: 'violet',
  },
  {
    name: '参与人次',
    value: totals.value.participants,
    hint: '当前有效报名中的队员人次',
    color: 'cyan',
  },
  {
    name: '审核通过',
    value: totals.value.approved,
    hint: `${approvalPercent.value}% 当前报名通过审核`,
    color: 'green',
  },
  {
    name: '取得资格',
    value: totals.value.eligible,
    hint: `${totals.value.pending ?? 0} 份等待审核`,
    color: 'amber',
  },
]);
async function load() {
  const current = ++sequence;
  loading.value = true;
  try {
    const result = await api(
      `/overview${selected.value ? `?contestId=${encodeURIComponent(selected.value)}` : ''}`,
    );
    if (sequence !== current) return;
    data.value = result;
    error.value = '';
  } catch (e) {
    if (sequence === current) error.value = e instanceof Error ? e.message : '统计数据加载失败';
  } finally {
    if (sequence === current) loading.value = false;
  }
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await screen.value?.requestFullscreen();
  } catch {
    ElMessage.info('当前浏览器不支持全屏，可使用浏览器全屏查看大屏。');
  }
}
onMounted(() => {
  load();
  refreshTimer = setInterval(() => {
    if (!loading.value && !document.hidden) load();
  }, 30000);
  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 1000);
});
onBeforeUnmount(() => {
  clearInterval(refreshTimer);
  clearInterval(clockTimer);
  sequence++;
});
</script>
<template>
  <div class="overview-screen" ref="screen">
    <div class="overview-heading page-heading">
      <div>
        <h1>活动总览</h1>
        <p class="subtitle">活动报名与参与数据大屏</p>
      </div>
      <div class="overview-controls">
        <span class="overview-clock">{{ date(now.toISOString()) }}</span>
        <div class="button-group">
          <el-select
            v-model="selected"
            filterable
            clearable
            placeholder="全部活动"
            aria-label="选择统计活动"
            @change="load"
            ><el-option
              v-for="choice in data?.choices ?? []"
              :key="choice.id"
              :label="choice.title"
              :value="choice.id"
          /></el-select>
          <el-button :loading="loading" @click="load">刷新数据</el-button
          ><el-button @click="fullscreen">全屏大屏</el-button>
        </div>
      </div>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="overview-metrics" v-loading="loading && !data">
      <article
        v-for="metric in metrics"
        :key="metric.name"
        :class="['overview-metric', metric.color]"
      >
        <span>{{ metric.name }}</span
        ><strong>{{ metric.value ?? 0 }}</strong
        ><small>{{ metric.hint }}</small>
      </article>
    </div>
    <div class="overview-charts">
      <section class="overview-panel">
        <div class="overview-panel-heading">
          <h2>各活动报名规模</h2>
          <small>按当前有效报名排序</small>
        </div>
        <div v-if="bars.length" class="overview-bars">
          <div v-for="activity in bars" :key="activity.id" class="overview-bar-row">
            <span :title="activity.title">{{ activity.title }}</span>
            <div class="overview-bar-track">
              <div :style="{ width: `${(activity.active / max) * 100}%` }"></div>
            </div>
            <strong>{{ activity.active }}</strong>
          </div>
        </div>
        <p v-else class="overview-empty">暂无活动数据</p>
      </section>
      <section class="overview-panel">
        <div class="overview-panel-heading">
          <h2>报名审核进度</h2>
          <small>当前有效报名</small>
        </div>
        <div class="overview-review">
          <div
            class="overview-donut"
            :style="{
              background: `conic-gradient(var(--el-color-success) ${approvalPercent}%, #f0f2f5 0)`,
            }"
          >
            <div>
              <strong>{{ approvalPercent }}%</strong><span>审核通过</span>
            </div>
          </div>
          <div class="overview-legend">
            <p>
              <i class="approved"></i>已通过<strong>{{ totals.approved ?? 0 }}</strong>
            </p>
            <p>
              <i class="pending"></i>等待审核<strong>{{ totals.pending ?? 0 }}</strong>
            </p>
            <p>
              <i class="correction"></i>待补正<strong>{{ totals.correction ?? 0 }}</strong>
            </p>
            <p>
              <i class="cancelled"></i>历史取消<strong>{{ totals.cancelled ?? 0 }}</strong>
            </p>
          </div>
        </div>
      </section>
    </div>
    <section class="overview-panel">
      <div class="overview-panel-heading">
        <h2>活动统计明细</h2>
        <small
          >统计更新时间：{{ data?.updatedAt ? date(data.updatedAt) : '加载中' }} · 每 30
          秒更新</small
        >
      </div>
      <div class="overview-table-scroll">
        <table class="overview-table">
          <thead>
            <tr>
              <th>活动</th>
              <th>报名阶段</th>
              <th>累计提交</th>
              <th>有效报名</th>
              <th>参与人次</th>
              <th>待审核</th>
              <th>审核通过</th>
              <th>取得资格</th>
              <th>非正式</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="activity in data?.activities ?? []" :key="activity.id">
              <td>
                <router-link :to="`/contests/${activity.id}`">{{ activity.title }}</router-link
                ><small>{{ activity.season }} · {{ date(activity.startsAt) }}</small>
              </td>
              <td>
                <span :class="['overview-phase', activity.phase.toLowerCase()]">{{
                  phases[activity.phase]
                }}</span>
              </td>
              <td>{{ activity.submitted }}</td>
              <td>{{ activity.active }}</td>
              <td>{{ activity.participants }}</td>
              <td>{{ activity.pending }}</td>
              <td>{{ activity.approved }}</td>
              <td>{{ activity.eligible }}</td>
              <td>{{ activity.unofficial }}</td>
            </tr>
            <tr v-if="!data?.activities.length">
              <td colspan="9" class="overview-empty">暂无活动数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p class="overview-note">
      仅展示您可查看的活动汇总数据。参与人次按各活动累计，同一用户参加多场活动会分别计数。
    </p>
  </div>
</template>
<style scoped>
.overview-screen {
  --screen-border: #ebeef2;
  background: #fff;
  color: var(--ink);
  min-height: 80vh;
}
.overview-screen:fullscreen {
  overflow: auto;
  padding: clamp(20px, 3vw, 42px);
}
.overview-heading {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: center;
  margin-bottom: 28px;
}
.overview-heading h1 {
  margin: 0 0 8px;
  font-size: 26px;
  font-weight: 650;
}
.overview-heading p,
.overview-note {
  color: var(--muted);
  font-size: 13px;
}
.overview-controls {
  min-width: 0;
  text-align: right;
}
.overview-clock {
  display: block;
  color: var(--muted);
  margin-bottom: 12px;
  font-variant-numeric: tabular-nums;
}
.overview-controls .el-select {
  width: 230px;
}
.overview-metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.overview-metric {
  border: 1px solid var(--screen-border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 2px 3px #1f293704;
  padding: 20px;
  min-width: 0;
}
.overview-metric span,
.overview-metric small {
  display: block;
}
.overview-metric span {
  color: #606266;
  font-size: 14px;
}
.overview-metric strong {
  display: block;
  font-size: clamp(28px, 2.5vw, 36px);
  padding: 13px 0;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-primary);
}
.overview-metric small {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
.overview-metric.green strong {
  color: var(--el-color-success);
}
.overview-metric.amber strong {
  color: var(--el-color-warning);
}
.overview-charts {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 24px;
  margin-bottom: 24px;
}
.overview-panel {
  min-width: 0;
  border: 1px solid var(--screen-border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 2px 3px #1f293704;
  padding: 24px;
}
.overview-panel-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 24px;
}
.overview-panel h2 {
  font-size: 19px;
  font-weight: 600;
  margin: 0;
  color: var(--ink);
}
.overview-panel small {
  color: var(--muted);
  font-size: 12px;
}
.overview-bar-row {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) 2fr 36px;
  gap: 15px;
  align-items: center;
  margin: 20px 0;
  font-size: 13px;
}
.overview-bar-row > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.overview-bar-row strong {
  text-align: right;
  color: var(--el-color-primary);
}
.overview-bar-track {
  height: 10px;
  background: #f0f2f5;
  border-radius: 6px;
  overflow: hidden;
}
.overview-bar-track > div {
  height: 100%;
  background: var(--el-color-primary);
  border-radius: inherit;
  transition: width 0.3s;
}
.overview-review {
  display: flex;
  justify-content: space-evenly;
  gap: 28px;
  align-items: center;
  min-height: 200px;
  flex-wrap: wrap;
}
.overview-donut {
  width: 168px;
  height: 168px;
  border-radius: 50%;
  display: grid;
  place-items: center;
}
.overview-donut > div {
  width: 142px;
  height: 142px;
  background: #fff;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 8px;
}
.overview-donut strong {
  font-size: 32px;
  color: var(--el-color-success);
}
.overview-donut span {
  font-size: 12px;
  color: var(--muted);
}
.overview-legend {
  min-width: 145px;
}
.overview-legend p {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.overview-legend strong {
  margin-left: auto;
}
.overview-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-success);
}
.overview-legend .pending {
  background: var(--el-color-primary);
}
.overview-legend .correction {
  background: var(--el-color-warning);
}
.overview-legend .cancelled {
  background: var(--muted);
}
.overview-table-scroll {
  overflow-x: auto;
}
.overview-table {
  border-collapse: collapse;
  width: 100%;
  min-width: 890px;
  font-size: 13px;
  text-align: left;
}
.overview-table th {
  color: var(--muted);
  font-weight: 500;
  padding: 0 14px 16px;
  white-space: nowrap;
}
.overview-table td {
  border-top: 1px solid var(--screen-border);
  padding: 17px 14px;
}
.overview-table td:first-child {
  min-width: 200px;
}
.overview-table a {
  color: var(--el-color-primary);
}
.overview-table small {
  display: block;
  margin-top: 7px;
}
.overview-phase {
  display: inline-block;
  padding: 5px 10px;
  border-radius: 20px;
  background: #f5f6f8;
  color: var(--muted);
  white-space: nowrap;
}
.overview-phase.open {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}
.overview-phase.upcoming {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.overview-empty {
  padding: 30px;
  color: var(--muted);
  text-align: center;
}
.overview-note {
  margin: 20px 0 0;
  line-height: 1.8;
}
@media (max-width: 1280px) {
  .overview-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .overview-heading {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }
  .overview-controls {
    text-align: left;
  }
  .overview-controls .el-select {
    width: 100%;
  }
  .overview-controls .button-group {
    width: 100%;
  }
  .overview-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .overview-metric {
    padding: 14px;
  }
  .overview-charts {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }
  .overview-panel {
    padding: 18px;
  }
}
</style>
