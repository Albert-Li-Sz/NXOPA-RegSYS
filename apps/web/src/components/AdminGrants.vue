<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  adminPermissions,
  adminPermissionLabels,
  adminLevelLabels,
} from '@contest-center/contracts';
import { api, auth, date, loadAuth } from '../api';
import { isSystemAdmin } from '../permissions';
import type { Data } from '../types';
const rows = ref<Data[]>([]),
  users = ref<Data[]>([]),
  contests = ref<Data[]>([]),
  dialog = ref(false),
  busy = ref(false),
  form = ref<Data>({}),
  search = ref('');
const filtered = computed(() =>
  rows.value.filter(
    (row) => !search.value || `${row.user.name} ${row.user.email}`.includes(search.value),
  ),
);
async function load() {
  [rows.value, contests.value] = await Promise.all([
    api('/admin/grants'),
    api('/contests?all=true'),
  ]);
}
async function searchUsers(query: string) {
  users.value = (
    await api(`/admin/users?page=1&pageSize=100&search=${encodeURIComponent(query)}`)
  ).items;
}
async function create() {
  form.value = {
    userId: '',
    level: isSystemAdmin() ? 'SENIOR' : 'CONTEST',
    contestId: '',
    permissions: [...adminPermissions],
    expiresAt: null,
  };
  await searchUsers('');
  dialog.value = true;
}
async function save() {
  busy.value = true;
  try {
    await api('/admin/grants', 'POST', {
      ...form.value,
      contestId: form.value.level === 'CONTEST' ? form.value.contestId : null,
      expiresAt: form.value.expiresAt || null,
    });
    dialog.value = false;
    await load();
    await loadAuth();
    ElMessage.success('管理授权已生效');
  } finally {
    busy.value = false;
  }
}
async function revoke(row: Data) {
  await ElMessageBox.confirm(`撤回 ${row.user.name} 的授权后立即失去对应管理权限。`, '撤回授权', {
    type: 'warning',
  });
  await api(`/admin/grants/${row.id}`, 'DELETE');
  await load();
  await loadAuth();
  ElMessage.success('授权已撤回');
}
const contestName = (id: string) => contests.value.find((c) => c.id === id)?.title || id;
const permissionLabel = (p: string) =>
  adminPermissionLabels[p as keyof typeof adminPermissionLabels] || p;
const levelLabel = (p: string) => adminLevelLabels[p as keyof typeof adminLevelLabels] || p;
const permissionNames = (items: string[]) => items.map(permissionLabel).join('、');
const state = (row: Data) =>
  row.revokedAt
    ? '已撤回'
    : row.expiresAt && new Date(row.expiresAt) <= new Date()
      ? '已到期'
      : '有效';
onMounted(load);
</script>
<template>
  <div class="card">
    <div class="member-heading">
      <h3>管理员授权</h3>
      <el-button type="primary" @click="create">新增授权</el-button>
    </div>
    <p class="form-help">
      用户类型只有学生、教师。管理员权限独立授权，支持撤回与期限。高级管理员不能配置核心信息。
    </p>
    <div class="toolbar">
      <el-input
        v-model="search"
        clearable
        placeholder="搜索姓名 / 邮箱"
        style="max-width: 320px"
      /><el-button @click="load">刷新</el-button>
    </div>
    <el-table :data="filtered"
      ><el-table-column label="用户" min-width="200"
        ><template #default="{ row }"
          ><strong>{{ row.user.name }}</strong> ·
          {{ row.user.kind === 'TEACHER' ? '教师' : '学生' }}
          <p class="muted">{{ row.user.email }}</p></template
        ></el-table-column
      ><el-table-column label="授权范围" min-width="240"
        ><template #default="{ row }"
          >{{ levelLabel(row.level) }}
          <p>{{ row.contestId ? contestName(row.contestId) : '全站' }}</p>
          <small class="muted">{{ permissionNames(row.permissions) }}</small></template
        ></el-table-column
      ><el-table-column label="有效期限" width="185"
        ><template #default="{ row }">{{
          row.expiresAt ? date(row.expiresAt) : '永久'
        }}</template></el-table-column
      ><el-table-column label="状态" width="100"
        ><template #default="{ row }"
          ><el-tag :type="state(row) === '有效' ? 'success' : 'info'">{{
            state(row)
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="操作" width="100"
        ><template #default="{ row }"
          ><el-button
            v-if="!row.revokedAt && (row.level === 'CONTEST' || isSystemAdmin())"
            text
            type="danger"
            @click="revoke(row)"
            >撤回</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </div>
  <el-dialog v-model="dialog" title="新增管理授权" width="660px"
    ><el-form label-position="top" @submit.prevent="save"
      ><el-form-item label="接收者"
        ><el-select
          v-model="form.userId"
          filterable
          remote
          :remote-method="searchUsers"
          style="width: 100%"
          placeholder="搜索姓名、用户名或邮箱"
          ><el-option
            v-for="user in users"
            :key="user.id"
            :value="user.id"
            :label="`${user.name} · ${user.email}`" /></el-select></el-form-item
      ><el-form-item label="管理员级别"
        ><el-select v-model="form.level" style="width: 100%" filterable
          ><el-option
            v-for="level in isSystemAdmin() ? ['SYSTEM', 'SENIOR', 'CONTEST'] : ['CONTEST']"
            :key="level"
            :value="level"
            :label="levelLabel(level)" /></el-select></el-form-item
      ><template v-if="form.level === 'CONTEST'"
        ><el-form-item label="竞赛"
          ><el-select v-model="form.contestId" filterable style="width: 100%"
            ><el-option
              v-for="contest in contests"
              :key="contest.id"
              :value="contest.id"
              :label="contest.title" /></el-select></el-form-item
        ><el-form-item label="权限项"
          ><el-checkbox-group v-model="form.permissions"
            ><el-checkbox
              v-for="permission in adminPermissions"
              :key="permission"
              :value="permission"
              :disabled="permission === 'VIEW'"
              >{{ adminPermissionLabels[permission] }}</el-checkbox
            ></el-checkbox-group
          ></el-form-item
        ></template
      ><el-form-item label="到期时间（留空为永久授权）"
        ><el-date-picker
          v-model="form.expiresAt"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ"
          style="width: 100%"
          clearable /></el-form-item></el-form
    ><template #footer
      ><el-button @click="dialog = false">取消</el-button
      ><el-button
        type="primary"
        :disabled="!form.userId || (form.level === 'CONTEST' && !form.contestId)"
        :loading="busy"
        @click="save"
        >授权</el-button
      ></template
    ></el-dialog
  >
</template>
