<script setup lang="ts">
import PaginatedTable from './PaginatedTable.vue';
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { defaultFields, fieldSchema } from '@contest-center/contracts';
import { api, auth, date, label, loadAuth } from '../api';
import type { Data } from '../types';
import { useEditSession } from '../composables/useEditSession';
import DynamicFields from './DynamicFields.vue';

const props = withDefaults(defineProps<{ id: string; endpoint?: string }>(), { endpoint: 'users' });
const emit = defineEmits<{ close: []; changed: [] }>();
const detail = ref<Data>(),
  form = ref<Data>(),
  editing = ref(false),
  busy = ref(false),
  error = ref('');
const editSession = useEditSession(form);
watch(editing, (value) => (value ? editSession.begin() : editSession.finish()), { flush: 'sync' });
async function beforeClose(done: () => void) {
  if (!busy.value && (await editSession.mayLeave())) done();
}
const visible = computed({
  get: () => !!props.id,
  set: (value) => {
    if (!value) emit('close');
  },
});
const teacher = computed(() => detail.value?.kind === 'TEACHER');
const fields = computed(() => [
  ...defaultFields
    .filter((field) => !teacher.value || !['student_id', 'class_name'].includes(field.key))
    .map((field) => ({ ...field, required: false })),
  ...(teacher.value
    ? [
        fieldSchema.parse({ key: 'employee_id', label: '工号', scope: 'PERSON', type: 'text' }),
        fieldSchema.parse({ key: 'employed_at', label: '入职日期', scope: 'PERSON', type: 'date' }),
      ]
    : [
        fieldSchema.parse({
          key: 'enrollment_year',
          label: '入学年份',
          scope: 'PERSON',
          type: 'number',
          min: 1950,
          max: new Date().getFullYear() + 1,
        }),
      ]),
]);
watch(
  () => props.id,
  async (id, _previous, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    detail.value = undefined;
    editing.value = false;
    error.value = '';
    if (!id) return;
    try {
      const result = await api(`/admin/${props.endpoint}/${id}`);
      if (current) detail.value = result;
    } catch (e) {
      if (current) error.value = e instanceof Error ? e.message : '账号详情加载失败';
    }
  },
);
function edit() {
  form.value = JSON.parse(JSON.stringify(detail.value));
  editing.value = true;
}
async function save() {
  if (!form.value) return;
  busy.value = true;
  try {
    detail.value = await api(`/admin/users/${props.id}`, 'PUT', {
      version: form.value.version,
      name: form.value.name,
      username: form.value.username,
      email: form.value.email,
      profile: form.value.profile,
      tags: form.value.tags,
    });
    editing.value = false;
    if (props.id === auth.user?.id) await loadAuth();
    emit('changed');
    ElMessage.success('用户信息已保存');
  } finally {
    busy.value = false;
  }
}
async function ban() {
  if (!detail.value) return;
  const banned = !detail.value.bannedAt;
  let reason = '';
  try {
    if (banned)
      ({ value: reason } = await ElMessageBox.prompt(
        '填写封禁原因，封禁后现有登录立即失效',
        '封禁账号',
        { inputPlaceholder: '封禁原因', confirmButtonText: '确认封禁', cancelButtonText: '取消' },
      ));
    else
      await ElMessageBox.confirm('解除封禁后，该账号可以重新登录。', '解除封禁', {
        confirmButtonText: '确认解除',
        cancelButtonText: '取消',
      });
  } catch {
    return;
  }
  busy.value = true;
  try {
    detail.value = await api(`/admin/users/${props.id}/ban`, 'PUT', {
      version: detail.value.version,
      banned,
      reason,
    });
    emit('changed');
    ElMessage.success(banned ? '账号已封禁' : '封禁已解除');
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!detail.value) return;
  try {
    await ElMessageBox.prompt(
      '删除后账号不能登录，邮箱和用户名将释放，参赛历史保留。请输入“删除账号”确认。',
      '删除账号',
      {
        inputPattern: /^删除账号$/,
        inputErrorMessage: '请输入“删除账号”',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await api(`/admin/users/${props.id}`, 'DELETE', {
      version: detail.value.version,
      confirmation: '删除账号',
    });
    emit('changed');
    emit('close');
    ElMessage.success('账号已删除，参赛历史已保留');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-dialog
    :before-close="beforeClose"
    v-model="visible"
    :title="`${detail?.name || '账号'} · ${teacher ? '教师' : '学生'}详情`"
    width="960px"
    class="user-detail-dialog"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="detail">
      <div class="toolbar">
        <el-tag :type="detail.bannedAt ? 'danger' : 'success'">{{
          detail.bannedAt ? '已封禁' : '正常'
        }}</el-tag>
        <span>{{ detail.email }} · {{ detail.username }}</span>
        <span class="muted">注册于 {{ date(detail.createdAt) }}</span>
      </div>
      <el-alert
        v-if="detail.bannedAt"
        type="warning"
        :title="`封禁原因：${detail.banReason || '未填写'}`"
        :closable="false"
      />
      <div class="actions" v-if="detail.canEdit && !editing">
        <el-button type="primary" :disabled="busy" @click="edit"
          >修改{{ teacher ? '教师' : '学生' }}信息</el-button
        >
        <el-button
          v-if="detail.id !== auth.user?.id"
          :type="detail.bannedAt ? 'success' : 'warning'"
          :loading="busy"
          @click="ban"
          >{{ detail.bannedAt ? '解除封禁' : '封禁账号' }}</el-button
        >
        <el-button v-if="detail.canDelete" type="danger" :loading="busy" @click="remove"
          >删除账号</el-button
        >
      </div>
      <el-form v-if="editing && form" label-position="top" @submit.prevent="save">
        <div class="form-grid">
          <el-form-item label="姓名" for="admin-user-name" required
            ><el-input id="admin-user-name" v-model="form.name"
          /></el-form-item>
          <el-form-item label="用户名" for="admin-user-username" required
            ><el-input id="admin-user-username" v-model="form.username"
          /></el-form-item>
          <el-form-item label="邮箱" for="admin-user-email" required
            ><el-input id="admin-user-email" v-model="form.email" type="email" /><span
              class="form-help"
              >修改邮箱后需要重新验证邮箱，并重新登录。</span
            ></el-form-item
          >
          <el-form-item label="用户标签"
            ><el-select
              v-model="form.tags"
              multiple
              filterable
              allow-create
              default-first-option
              style="width: 100%"
          /></el-form-item>
        </div>
        <DynamicFields
          :fields="fields"
          scope="PERSON"
          :answers="form.profile"
          prefix="admin-user"
        />
        <div class="actions">
          <el-button type="primary" native-type="submit" :loading="busy">保存用户信息</el-button
          ><el-button :disabled="busy" @click="editing = false">取消修改</el-button>
        </div>
      </el-form>
      <el-descriptions v-else :column="2" border>
        <el-descriptions-item v-for="field in fields" :key="field.key" :label="field.label">{{
          detail.profile[field.key] || '—'
        }}</el-descriptions-item>
      </el-descriptions>
      <h3>参与活动</h3>
      <PaginatedTable
        page-key="userdetail-detail-registrations"
        :data="detail.registrations"
        empty-text="暂无活动记录"
      >
        <el-table-column label="竞赛" min-width="220"
          ><template #default="{ row }"
            ><router-link :to="`/registrations/${row.id}`">{{
              row.contest.title
            }}</router-link></template
          ></el-table-column
        >
        <el-table-column prop="number" label="编号" width="90" />
        <el-table-column label="性质" width="120"
          ><template #default="{ row }">{{
            label(row.participationType)
          }}</template></el-table-column
        >
        <el-table-column label="状态" width="120"
          ><template #default="{ row }">{{ label(row.review) }}</template></el-table-column
        >
        <el-table-column label="时间" width="180"
          ><template #default="{ row }">{{
            date(row.submittedAt || row.createdAt)
          }}</template></el-table-column
        >
      </PaginatedTable>
    </template>
  </el-dialog>
</template>
<style>
.user-detail-dialog {
  max-width: calc(100vw - 32px);
}
@media (max-width: 760px) {
  .user-detail-dialog .el-descriptions__label {
    min-width: 68px;
  }
}
</style>
