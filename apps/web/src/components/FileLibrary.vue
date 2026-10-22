<script setup lang="ts">
import { onMounted, onBeforeUnmount, defineAsyncComponent, ref, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, date, handleAuthResponse } from '../api';
import { canManage, ownUser } from '../permissions';
import type { Data } from '../types';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'));
const props = withDefaults(
  defineProps<{
    contestId?: string;
    registrationId?: string;
    personal?: boolean;
    canUpload?: boolean;
  }>(),
  { canUpload: undefined },
);
const list = usePagedList('file-library', () => {
  const query = new URLSearchParams(
    props.registrationId
      ? { registrationId: props.registrationId }
      : props.contestId
        ? { contestId: props.contestId }
        : {},
  );
  return `/files?${query}`;
});
const rows = list.items,
  busy = ref(false),
  error = list.error,
  scope = ref('CONTEST_PUBLIC'),
  distributing = ref(false),
  selected = ref<string[]>([]),
  teams = ref<Data[]>([]),
  fileId = ref(''),
  publicBase = ref('');
const previewFile = ref<Data>(),
  previewOpen = ref(false),
  previewLoading = ref(false),
  previewError = ref(''),
  previewUrl = ref('');
let previewSequence = 0,
  previewRequest: AbortController | undefined;
const allowed = computed(
  () => props.canUpload ?? (!props.contestId || canManage(props.contestId, 'FILES')),
);
const title = computed(() =>
  props.registrationId ? '队伍附件' : props.contestId ? '竞赛材料与队伍分发' : '我的附件',
);
const purposes: Record<string, string> = {
  PRIVATE: '报名资料',
  PERSONAL: '个人附件',
  TEAM: '队伍上传',
  CONTEST_PUBLIC: '公开竞赛材料',
  CONTEST_PRIVATE: '管理员分发',
  AVATAR: '头像',
};
const link = (row: Data) => `/api/v1/files/${row.id}`;
const isPdf = (row: Data) => row.mime === 'application/pdf';
function clearPreview() {
  previewSequence++;
  previewRequest?.abort();
  previewRequest = undefined;
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  previewLoading.value = false;
}
async function preview(row: Data) {
  clearPreview();
  previewFile.value = row;
  previewError.value = '';
  previewLoading.value = true;
  previewOpen.value = true;
  const sequence = previewSequence,
    request = new AbortController();
  previewRequest = request;
  try {
    const response = await fetch(link(row), { credentials: 'same-origin', signal: request.signal });
    handleAuthResponse('/files', response.status);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'PDF 加载失败，请重试');
    }
    if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/pdf')
      throw new Error('此文件不支持 PDF 预览，请下载查看');
    const blob = await response.blob();
    if (sequence === previewSequence && previewOpen.value)
      previewUrl.value = URL.createObjectURL(blob);
  } catch (error) {
    if (sequence === previewSequence)
      previewError.value = error instanceof Error ? error.message : 'PDF 加载失败，请重试';
  } finally {
    if (sequence === previewSequence) previewLoading.value = false;
  }
}
async function refresh() {
  await list.load();
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  try {
    const body = new FormData();
    body.append('file', file);
    const query = new URLSearchParams({
      purpose: props.registrationId ? 'TEAM' : props.contestId ? scope.value : 'PERSONAL',
      ...(props.registrationId
        ? { registrationId: props.registrationId }
        : props.contestId
          ? { contestId: props.contestId }
          : {}),
    });
    const result = await api(`/files?${query}`, 'POST', body);
    ElMessage.success('文件已上传');
    if (result.public) await copy(result.url);
    await refresh();
  } finally {
    busy.value = false;
    input.value = '';
  }
}
async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('链接已复制，可插入比赛简介');
  } catch {
    await ElMessageBox.alert(url, '文件链接', { confirmButtonText: '关闭' });
  }
}
async function remove(row: Data) {
  await ElMessageBox.confirm(`删除「${row.name}」后文件链接将失效。`, '删除附件', {
    type: 'warning',
  });
  await api(`/files/${row.id}`, 'DELETE');
  await refresh();
}
async function distribute(row: Data) {
  fileId.value = row.id;
  selected.value = [];
  const result = await api(`/registrations?contestId=${props.contestId}&page=1&pageSize=100`);
  teams.value = result.items;
  for (let page = 2; teams.value.length < result.total; page++) {
    const next = await api(`/registrations?contestId=${props.contestId}&page=${page}&pageSize=100`);
    if (!next.items.length) break;
    teams.value.push(...next.items);
  }
  distributing.value = true;
}
async function send() {
  await api(`/contests/${props.contestId}/files/distribute`, 'POST', {
    attachmentId: fileId.value,
    registrationIds: selected.value,
  });
  distributing.value = false;
  ElMessage.success('已分发给选中的队伍');
}
const publicUrl = (row: Data) =>
  new URL(link(row), publicBase.value || window.location.origin).href;
onMounted(async () => {
  await Promise.allSettled([
    api('/site').then((site) => (publicBase.value = site.publicUrl)),
    refresh(),
  ]);
});
watch(
  () => [props.contestId, props.registrationId],
  () => {
    if (list.page.value === 1) void refresh();
    else list.page.value = 1;
  },
);
watch(previewOpen, (open) => {
  if (!open) clearPreview();
});
onBeforeUnmount(clearPreview);
</script>
<template>
  <div class="card file-library" data-pagination-key="files">
    <div class="member-heading">
      <h3>{{ title }}</h3>
      <el-button @click="refresh">刷新</el-button>
    </div>
    <p class="form-help">
      支持 PDF、PNG、JPEG、文本和 ZIP，单个附件最多 50
      MB。队伍成员可查看收到的文件，并删除本人上传的文件。
    </p>
    <div v-if="allowed" class="toolbar">
      <el-select
        v-if="contestId && !registrationId"
        v-model="scope"
        aria-label="材料可见范围"
        style="max-width: 220px"
        filterable
        ><el-option label="公开材料：可生成简介链接" value="CONTEST_PUBLIC" /><el-option
          label="私有材料：分发给指定队伍"
          value="CONTEST_PRIVATE"
      /></el-select>
      <label class="file-upload-label"
        >上传文件<input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.txt,.zip"
          :disabled="busy"
          @change="upload" /></label
      ><span v-if="busy">正在上传…</span>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-input
      v-model="list.filters.value.search"
      placeholder="搜索文件名称"
      clearable
      style="max-width: 360px; margin-bottom: 16px"
    />
    <el-table :data="rows" v-loading="list.loading.value" empty-text="暂无附件">
      <el-table-column label="文件" min-width="200"
        ><template #default="{ row }"
          ><a v-if="isPdf(row)" :href="link(row)" @click.prevent="preview(row)">{{ row.name }}</a
          ><a v-else :href="link(row)" target="_blank" rel="noopener">{{ row.name }}</a></template
        ></el-table-column
      >
      <el-table-column label="用途" width="145"
        ><template #default="{ row }">{{
          purposes[row.purpose] || row.purpose
        }}</template></el-table-column
      >
      <el-table-column label="大小" width="95"
        ><template #default="{ row }"
          >{{ (row.size / 1024).toFixed(1) }} KB</template
        ></el-table-column
      >
      <el-table-column label="上传时间" width="170"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      >
      <el-table-column label="操作" min-width="180"
        ><template #default="{ row }"
          ><div class="button-group">
            <el-button v-if="isPdf(row)" text type="primary" @click="preview(row)">预览</el-button>
            <a :href="link(row)" class="file-download">下载</a>
            <el-button v-if="row.public" text @click="copy(publicUrl(row))">复制链接</el-button
            ><el-button
              v-if="contestId && row.purpose === 'CONTEST_PRIVATE' && allowed"
              text
              type="primary"
              @click="distribute(row)"
              >分发</el-button
            ><el-button
              v-if="ownUser(row.ownerId) || (row.contestId && canManage(row.contestId, 'FILES'))"
              text
              type="danger"
              @click="remove(row)"
              >删除</el-button
            >
          </div></template
        ></el-table-column
      >
    </el-table>
    <ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
      :loading="list.loading.value"
    />
  </div>
  <el-dialog
    v-model="previewOpen"
    :title="`PDF 预览 · ${previewFile?.name || ''}`"
    width="1100px"
    destroy-on-close
  >
    <div v-loading="previewLoading" class="file-preview-body">
      <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" />
      <PdfPreview v-if="previewUrl" :src="previewUrl" />
    </div>
    <template #footer>
      <div class="button-group file-preview-actions">
        <span class="form-help">无法显示时，可在新窗口预览或下载文件。</span>
        <a v-if="previewUrl" :href="previewUrl" target="_blank" rel="noopener">新窗口预览</a>
        <a v-if="previewFile" :href="link(previewFile)">下载文件</a>
        <el-button @click="previewOpen = false">关闭</el-button>
      </div>
    </template>
  </el-dialog>
  <el-dialog v-model="distributing" title="分发队伍附件" width="620px"
    ><p class="form-help">仅选中的队伍及竞赛管理员可以下载此文件。</p>
    <el-select
      v-model="selected"
      multiple
      :multiple-limit="500"
      filterable
      placeholder="选择队伍"
      style="width: 100%"
      ><el-option
        v-for="team in teams"
        :key="team.id"
        :value="team.id"
        :label="`#${team.number || '草稿'} ${team.teamName || team.people?.[0]?.name || ''}`" /></el-select
    ><template #footer
      ><el-button @click="distributing = false">取消</el-button
      ><el-button type="primary" :disabled="!selected.length" @click="send"
        >确认分发</el-button
      ></template
    ></el-dialog
  >
</template>
<style scoped>
.file-download {
  font-size: 14px;
}
.file-preview-body {
  min-height: 120px;
}
.file-preview-actions {
  justify-content: flex-end;
}
.file-preview-actions .form-help {
  margin: 0 auto 0 0;
}
</style>
