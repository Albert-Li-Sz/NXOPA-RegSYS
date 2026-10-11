<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import type { Data } from '../types';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
const props = defineProps<{ bindingId: string }>();
const list = usePagedList(
  'school-mappings',
  () => `/integrations/bindings/${props.bindingId}/schools`,
);
const organizations = ref<Data[]>([]),
  groups = ref<Data[]>([]),
  editing = ref<Data>(),
  mode = ref('existing'),
  busy = ref(false),
  error = ref('');
async function load() {
  await list.load();
  try {
    const metadata = await api(`/integrations/bindings/${props.bindingId}/metadata`);
    organizations.value = metadata.organizations;
    groups.value = metadata.groups;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '远端学校与分组无法加载';
  }
}
onMounted(load);
function edit(row: Data) {
  editing.value = { ...row, remoteId: row.remoteId ?? '' };
  mode.value = row.remoteId ? 'existing' : 'create';
}
async function save() {
  if (!editing.value) return;
  busy.value = true;
  try {
    await api(`/integrations/bindings/${props.bindingId}/schools/${editing.value.id}`, 'PUT', {
      ...editing.value,
      remoteId: mode.value === 'existing' ? editing.value.remoteId : undefined,
      create: mode.value === 'create',
    });
    editing.value = undefined;
    ElMessage.success('学校映射已确认，等待中的同步将继续');
    await load();
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="notice">新学校须由管理员确认对应远端组织。报名仍可提交，确认后继续平台同步。</div>
  <el-alert
    v-if="error || list.error.value"
    :title="error || list.error.value"
    type="error"
    :closable="false"
  />
  <div class="toolbar">
    <el-input v-model="list.filters.value.search" placeholder="搜索学校" clearable /><el-select
      v-model="list.filters.value.status"
      clearable
      placeholder="映射状态"
      ><el-option value="PENDING" label="待确认" /><el-option
        value="CONFIRMED"
        label="已确认" /></el-select
    ><el-button @click="load">刷新</el-button>
  </div>
  <el-table :data="list.items.value" empty-text="暂无需要映射的学校"
    ><el-table-column prop="name" label="学校／单位" min-width="200" /><el-table-column
      prop="shortName"
      label="简称"
      min-width="100"
    /><el-table-column prop="country" label="国家／地区" width="100" /><el-table-column
      label="状态"
      width="110"
      ><template #default="{ row }"
        ><el-tag :type="row.status === 'CONFIRMED' ? 'success' : 'warning'">{{
          row.status === 'CONFIRMED' ? '已确认' : '待确认'
        }}</el-tag></template
      ></el-table-column
    ><el-table-column prop="remoteId" label="远端组织编号" min-width="160" /><el-table-column
      label="操作"
      width="110"
      ><template #default="{ row }"
        ><el-button text type="primary" @click="edit(row)">确认映射</el-button></template
      ></el-table-column
    ></el-table
  >
  <ListPagination
    v-model:page="list.page.value"
    v-model:size="list.pageSize.value"
    :total="list.total.value"
  />
  <h3>目标比赛允许的分组</h3>
  <el-table :data="groups"
    ><el-table-column prop="id" label="分组编号" /><el-table-column
      prop="name"
      label="名称" /><el-table-column prop="sortorder" label="排名顺序"
  /></el-table>
  <el-dialog
    :model-value="!!editing"
    @close="editing = undefined"
    title="确认学校映射"
    width="620px"
    append-to-body
    ><el-form v-if="editing" label-position="top" @submit.prevent="save"
      ><el-radio-group v-model="mode"
        ><el-radio-button value="existing">选择已有组织</el-radio-button
        ><el-radio-button value="create">确认创建组织</el-radio-button></el-radio-group
      ><el-form-item v-if="mode === 'existing'" label="远端组织" required
        ><el-select v-model="editing.remoteId" filterable
          ><el-option
            v-for="o in organizations"
            :key="o.id"
            :value="String(o.id)"
            :label="`${o.formal_name || o.name} · ${o.id}`" /></el-select
      ></el-form-item>
      <div class="form-grid">
        <el-form-item label="全称" required><el-input v-model="editing.name" /></el-form-item
        ><el-form-item label="简称（最多 32 字）" required
          ><el-input v-model="editing.shortName" maxlength="32" /></el-form-item
        ><el-form-item label="国家／地区三位代码" required
          ><el-input v-model="editing.country" maxlength="3" /></el-form-item
        ><el-form-item label="ICPC 编号（可选）"
          ><el-input v-model="editing.icpcId"
        /></el-form-item>
      </div>
      <el-button
        type="primary"
        native-type="submit"
        :loading="busy"
        :disabled="mode === 'existing' && !editing.remoteId"
        >确认并继续同步</el-button
      ></el-form
    ></el-dialog
  >
</template>
