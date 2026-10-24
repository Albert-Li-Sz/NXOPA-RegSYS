<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api';
import type { Data } from '../types';
import PaginatedTable from './PaginatedTable.vue';
const props = defineProps<{
  contestId: string;
  filters: string;
  selectedIds: string[];
  rooms: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{ busy: [value: boolean]; done: [] }>();
const mode = ref('SELECTED'),
  action = ref('GENERATE'),
  preview = ref<Data>(),
  dialog = ref(false),
  busy = ref(false),
  error = ref('');
const location = ref(''),
  room = ref(''),
  seat = ref(''),
  job = ref<Data>(),
  jobId = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const key = () => `cc:admission-batch:${props.contestId}`;
watch(
  () => props.selectedIds.length,
  (count) => {
    if (count) mode.value = 'SELECTED';
  },
);
async function poll() {
  if (!jobId.value || disposed) return;
  try {
    const previous = job.value?.state;
    job.value = await api(`/jobs/${jobId.value}`);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(job.value!.state)) {
      if (previous !== job.value!.state) emit('done');
      return;
    }
    timer = setTimeout(poll, 2000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '进度加载失败';
  }
}
async function retryJob() {
  try {
    await api(`/admin/jobs/${jobId.value}/retry`, 'POST', {});
    clearTimeout(timer);
    await poll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '重试失败';
  }
}
async function prepare(next: string, retryIds?: string[]) {
  error.value = '';
  action.value = next;
  busy.value = true;
  emit('busy', true);
  try {
    const scope = retryIds
      ? { mode: 'SELECTED', registrationIds: retryIds }
      : mode.value === 'SELECTED'
        ? { mode: 'SELECTED', registrationIds: [...props.selectedIds] }
        : { mode: 'FILTERED', filters: Object.fromEntries(new URLSearchParams(props.filters)) };
    preview.value = await api(`/contests/${props.contestId}/admission-batches/preview`, 'POST', {
      action: next,
      scope,
      options: { location: location.value, room: room.value, seat: seat.value },
    });
    preview.value!.scopeLabel =
      scope.mode === 'SELECTED' ? '已勾选报名（跨页）' : '当前筛选条件下的全部报名';
    dialog.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '预览失败';
  } finally {
    busy.value = false;
    emit('busy', false);
  }
}
async function start() {
  busy.value = true;
  emit('busy', true);
  try {
    const result = await api(`/contests/${props.contestId}/admission-batches`, 'POST', {
      previewId: preview.value!.previewId,
    });
    jobId.value = result.jobId;
    localStorage.setItem(key(), jobId.value);
    dialog.value = false;
    job.value = undefined;
    clearTimeout(timer);
    await poll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '批次启动失败';
  } finally {
    busy.value = false;
    emit('busy', false);
  }
}
onMounted(() => {
  jobId.value = localStorage.getItem(key()) ?? '';
  void poll();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <div class="admission-batch-actions">
    <div class="actions">
      <el-select v-model="mode" aria-label="批量作用范围" :disabled="busy" style="width: 230px">
        <el-option value="SELECTED" :label="`已勾选 ${selectedIds.length} 份（支持跨页）`" />
        <el-option value="FILTERED" label="当前筛选条件下的全部报名" />
      </el-select>
      <el-button
        type="primary"
        :disabled="disabled || busy || (mode === 'SELECTED' && !selectedIds.length)"
        @click="prepare('GENERATE')"
        >批量生成准考证</el-button
      >
      <el-button
        :disabled="disabled || busy || (mode === 'SELECTED' && !selectedIds.length)"
        @click="prepare('RELEASE')"
        >批量发放准考证</el-button
      >
      <el-button
        :disabled="disabled || busy || (mode === 'SELECTED' && !selectedIds.length)"
        @click="prepare('DOWNLOAD')"
        >下载准考证 ZIP</el-button
      >
    </div>
    <div v-if="!rooms" class="actions">
      <el-input
        v-model="location"
        placeholder="考点（留空沿用活动／报名考点）"
        aria-label="批量考点"
        style="width: 280px"
      />
      <el-input v-model="room" placeholder="考场" aria-label="批量考场" style="width: 140px" />
      <el-input
        v-model="seat"
        placeholder="起始座位号（连续分配）"
        aria-label="批量起始座位号"
        style="width: 230px"
      />
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="job" class="card batch-progress" aria-label="准考证批次进度">
      <h3>
        准考证批次：{{
          ({ GENERATE: '生成', RELEASE: '发放', DOWNLOAD: '下载' } as Data)[job.result?.action]
        }}
      </h3>
      <p>
        共 {{ job.result?.total || 0 }} 份 · 成功 {{ job.result?.success || 0 }} · 跳过
        {{ job.result?.skipped || 0 }} · 失败 {{ job.result?.failed || 0 }} · 待处理
        {{ job.result?.pending || 0 }}
      </p>
      <el-progress
        :percentage="
          job.result?.total
            ? Math.round(((job.result.total - job.result.pending) * 100) / job.result.total)
            : 0
        "
      />
      <p v-if="job.error" role="alert">{{ job.error }}</p>
      <div class="actions">
        <el-button @click="poll">刷新进度</el-button>
        <el-button v-if="job.state === 'FAILED'" @click="retryJob">重新执行批次</el-button>
        <el-button
          v-if="job.result?.failed && job.state === 'SUCCESS'"
          @click="
            prepare(
              job.result.action,
              job.result.items.filter((i: Data) => i.state === 'FAILED').map((i: Data) => i.id),
            )
          "
          >重试失败项</el-button
        >
        <a
          v-for="file in job.result?.files || []"
          :key="file.downloadUrl"
          :href="file.downloadUrl"
          >{{ file.name }}</a
        >
      </div>
      <PaginatedTable :page-key="`batch-${job.id}`" :data="job.result?.items || []">
        <el-table-column label="报名" prop="name" min-width="160" /><el-table-column
          label="结果"
          prop="message"
          min-width="250"
        />
      </PaginatedTable>
    </div>
    <el-dialog
      v-model="dialog"
      title="确认准考证批量操作"
      width="min(660px, 94vw)"
      :show-close="!busy"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
    >
      <p>操作范围：{{ preview?.scopeLabel }}。</p>
      <p>
        本次{{
          ({ GENERATE: '生成', RELEASE: '发放', DOWNLOAD: '下载' } as Data)[action]
        }}范围已固定，共 {{ preview?.total }} 份，其中 {{ preview?.processable }} 份可处理，{{
          preview?.skipped?.length || 0
        }}
        份将跳过。
      </p>
      <p v-if="action === 'RELEASE'">发放后，参赛者可以下载准考证，并将收到通知。</p>
      <PaginatedTable
        v-if="preview?.skipped?.length"
        page-key="batch-preview-skips"
        :data="preview.skipped"
        ><el-table-column prop="name" label="报名" /><el-table-column
          prop="reason"
          label="跳过原因"
      /></PaginatedTable>
      <template #footer
        ><el-button :disabled="busy" @click="dialog = false">取消</el-button
        ><el-button type="primary" :loading="busy" :disabled="!preview?.processable" @click="start"
          >确认执行</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>
<style scoped>
.admission-batch-actions {
  width: 100%;
}
.batch-progress {
  margin-top: 16px;
}
@media (max-width: 600px) {
  .actions > .el-select,
  .actions > .el-input {
    width: 100% !important;
  }
}
</style>
