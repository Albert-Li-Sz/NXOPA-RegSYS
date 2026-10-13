<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, date, label } from '../api';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
import type { Data } from '../types';
const list = usePagedList('identities', () => '/admin/identities');
list.filters.value.status = 'PENDING';
onMounted(list.load);
const busy = ref(false);
async function review(row: Data, decision: string) {
  const { value } = await ElMessageBox.prompt(
    decision === 'APPROVED'
      ? '审核通过后资料生效，并关联同学号 / 工号的历史记录。'
      : '请填写审核未通过的原因。',
    '实名审核',
    {
      inputType: 'textarea',
      inputValidator: (value) => decision === 'APPROVED' || !!value?.trim(),
      inputErrorMessage: '请填写原因',
      confirmButtonText: decision === 'APPROVED' ? '通过' : '拒绝',
    },
  );
  busy.value = true;
  try {
    await api(`/admin/identities/${row.id}/review`, 'POST', { decision, reason: value || '' });
    await list.load();
    ElMessage.success('审核结果已保存');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="card">
    <h3>实名资料审核</h3>
    <div class="toolbar">
      <el-select v-model="list.filters.value.status" clearable placeholder="全部状态"
        ><el-option
          v-for="state in ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']"
          :key="state"
          :value="state"
          :label="label(state)" /></el-select
      ><el-button @click="list.load">刷新</el-button>
    </div>
    <el-alert
      v-if="list.error.value"
      :title="list.error.value"
      type="error"
      :closable="false"
    /><el-table :data="list.items.value"
      ><el-table-column label="账号" min-width="180"
        ><template #default="{ row }"
          >{{ row.user.name }}
          <p class="muted">{{ row.user.email }}</p></template
        ></el-table-column
      ><el-table-column label="申请资料" min-width="290"
        ><template #default="{ row }"
          ><strong>{{ row.data.name }}</strong> ·
          {{ row.data.kind === 'TEACHER' ? '教师' : '学生' }}
          <p>
            {{ row.data.profile.student_id || row.data.profile.employee_id }} ·
            {{ row.data.profile.class_name || row.data.profile.employed_at }}
          </p>
          <p>{{ row.data.profile.college }} · {{ row.data.profile.school || '' }}</p></template
        ></el-table-column
      ><el-table-column label="申请时间" width="180"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      ><el-table-column label="审核状态" min-width="150"
        ><template #default="{ row }"
          >{{ label(row.status) }}
          <p class="form-help">{{ row.reason }}</p></template
        ></el-table-column
      ><el-table-column label="操作" width="150"
        ><template #default="{ row }"
          ><template v-if="row.status === 'PENDING'"
            ><el-button text type="success" :disabled="busy" @click="review(row, 'APPROVED')"
              >通过</el-button
            ><el-button text type="danger" :disabled="busy" @click="review(row, 'REJECTED')"
              >拒绝</el-button
            ></template
          ></template
        ></el-table-column
      ></el-table
    ><ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
      :loading="list.loading.value"
    />
  </div>
</template>
