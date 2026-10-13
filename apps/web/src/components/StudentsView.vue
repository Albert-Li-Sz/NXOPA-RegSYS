<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, date, label } from '../api';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
import type { Data } from '../types';
const list = usePagedList('students', () => '/admin/students'),
  detail = ref<Data>(),
  visible = ref(false);
onMounted(list.load);
async function open(id: string) {
  detail.value = await api(`/admin/students/${id}`);
  visible.value = true;
}
</script>
<template>
  <div class="card">
    <h3>学生视图</h3>
    <p class="form-help">竞赛管理员仅能查看授权竞赛的学生及参赛记录。</p>
    <div class="toolbar">
      <el-input
        v-model="list.filters.value.search"
        clearable
        placeholder="姓名 / 邮箱"
        style="max-width: 320px"
      /><el-input
        v-model="list.filters.value.year"
        clearable
        placeholder="入学年份"
        style="max-width: 160px"
      />
    </div>
    <el-alert
      v-if="list.error.value"
      :title="list.error.value"
      type="error"
      :closable="false"
    /><el-table :data="list.items.value" v-loading="list.loading.value"
      ><el-table-column label="个人信息" min-width="210"
        ><template #default="{ row }"
          ><strong>{{ row.name }}</strong>
          <p>{{ row.profile.student_id }} · {{ row.profile.class_name || '—' }}</p>
          <small class="muted">{{ row.profile.college }}</small></template
        ></el-table-column
      ><el-table-column prop="email" label="邮箱" min-width="180" /><el-table-column
        label="入学年份"
        width="110"
        ><template #default="{ row }">{{
          row.profile.enrollment_year || '—'
        }}</template></el-table-column
      ><el-table-column
        prop="participationCount"
        label="报名参加次数"
        width="135"
      /><el-table-column
        prop="unofficialCount"
        label="非正式报名参加次数"
        width="170"
      /><el-table-column label="注册时间" width="180"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      ><el-table-column label="查看详情" width="110"
        ><template #default="{ row }"
          ><el-button text type="primary" @click="open(row.id)">查看详情</el-button></template
        ></el-table-column
      ></el-table
    ><ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
      :loading="list.loading.value"
    />
  </div>
  <el-dialog v-model="visible" :title="`${detail?.name || ''} · 参与活动`" width="850px"
    ><template v-if="detail"
      ><p>{{ detail.email }} · {{ detail.profile.student_id }} · {{ detail.profile.college }}</p>
      <el-table :data="detail.registrations" empty-text="暂无活动记录"
        ><el-table-column label="竞赛" min-width="220"
          ><template #default="{ row }"
            ><router-link :to="`/registrations/${row.id}`">{{
              row.contest.title
            }}</router-link></template
          ></el-table-column
        ><el-table-column prop="number" label="编号" width="90" /><el-table-column
          label="性质"
          width="120"
          ><template #default="{ row }">{{
            label(row.participationType)
          }}</template></el-table-column
        ><el-table-column label="状态" width="120"
          ><template #default="{ row }">{{ label(row.review) }}</template></el-table-column
        ><el-table-column label="时间" width="180"
          ><template #default="{ row }">{{
            date(row.submittedAt || row.createdAt)
          }}</template></el-table-column
        ></el-table
      ></template
    ></el-dialog
  >
</template>
