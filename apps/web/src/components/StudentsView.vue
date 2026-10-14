<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { date } from '../api';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
import UserDetail from './UserDetail.vue';
const props = withDefaults(defineProps<{ kind?: 'STUDENT' | 'TEACHER' }>(), { kind: 'STUDENT' });
const teacher = props.kind === 'TEACHER';
const endpoint = teacher ? 'teachers' : 'students';
const list = usePagedList(endpoint, () => `/admin/${endpoint}`),
  detailId = ref('');
onMounted(list.load);
defineExpose({ refresh: list.load });
</script>
<template>
  <div class="card">
    <h3>{{ teacher ? '教师视图' : '学生视图' }}</h3>
    <p class="form-help">竞赛管理员仅能查看授权竞赛的{{ teacher ? '教师' : '学生' }}及参与记录。</p>
    <div class="toolbar">
      <el-input
        v-model="list.filters.value.search"
        clearable
        placeholder="姓名 / 邮箱"
        style="max-width: 320px"
      /><el-input
        v-if="!teacher"
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
          <p>
            {{ teacher ? row.profile.employee_id : row.profile.student_id }} ·
            {{ teacher ? row.profile.employed_at || '—' : row.profile.class_name || '—' }}
          </p>
          <small class="muted">{{ row.profile.college }}</small></template
        ></el-table-column
      ><el-table-column prop="email" label="邮箱" min-width="180" /><el-table-column
        :label="teacher ? '入职日期' : '入学年份'"
        width="110"
        ><template #default="{ row }">{{
          (teacher ? row.profile.employed_at : row.profile.enrollment_year) || '—'
        }}</template></el-table-column
      ><el-table-column
        prop="participationCount"
        label="报名参加次数"
        width="135"
      /><el-table-column
        prop="unofficialCount"
        label="非正式报名参加次数"
        width="170"
      /><el-table-column label="账号状态" width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.bannedAt ? 'danger' : 'success'">{{
            row.bannedAt ? '已封禁' : '正常'
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="注册时间" width="180"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      ><el-table-column label="查看详情" width="110"
        ><template #default="{ row }"
          ><el-button text type="primary" @click="detailId = row.id">查看详情</el-button></template
        ></el-table-column
      ></el-table
    ><ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
      :loading="list.loading.value"
    />
  </div>
  <UserDetail :id="detailId" :endpoint="endpoint" @close="detailId = ''" @changed="list.load" />
</template>
