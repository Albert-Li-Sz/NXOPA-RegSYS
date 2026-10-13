<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, date } from '../api';
import { canManage, ownUser } from '../permissions';
import type { Data } from '../types';
const props = withDefaults(
  defineProps<{
    contestId?: string;
    registrationId?: string;
    personal?: boolean;
    canUpload?: boolean;
  }>(),
  { canUpload: undefined },
);
const rows = ref<Data[]>([]),
  busy = ref(false),
  error = ref(''),
  scope = ref('CONTEST_PUBLIC'),
  distributing = ref(false),
  selected = ref<string[]>([]),
  teams = ref<Data[]>([]),
  fileId = ref(''),
  publicBase = ref('');
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
const link = (row: Data) => `/api/v1/files/${row.public ? 'public/' : ''}${row.id}`;
async function refresh() {
  error.value = '';
  try {
    const query = new URLSearchParams(
      props.registrationId
        ? { registrationId: props.registrationId }
        : props.contestId
          ? { contestId: props.contestId }
          : {},
    );
    rows.value = await api(`/files?${query}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '文件加载失败';
  }
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
  publicBase.value = (await api('/site')).publicUrl;
  await refresh();
});
watch(() => [props.contestId, props.registrationId], refresh);
</script>
<template>
  <div class="card file-library">
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
    <el-table :data="rows" empty-text="暂无附件">
      <el-table-column label="文件" min-width="200"
        ><template #default="{ row }"
          ><a :href="link(row)" target="_blank" rel="noopener">{{ row.name }}</a></template
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
          ><el-button v-if="row.public" text @click="copy(publicUrl(row))">复制链接</el-button
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
          ></template
        ></el-table-column
      >
    </el-table>
  </div>
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
