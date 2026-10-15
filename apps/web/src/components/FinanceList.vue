<script setup lang="ts">
import { onMounted } from 'vue';
import { usePagedList } from '../composables/usePagedList';
import { money, date } from '../api';
import ListPagination from './ListPagination.vue';
const props = defineProps<{ contestId?: string; mine?: boolean }>();
const list = usePagedList(
  'finance-accounts',
  () =>
    `/finance/accounts${props.contestId ? `?contestId=${props.contestId}${props.mine ? '&role=mine' : ''}` : ''}`,
);
onMounted(list.load);
</script>
<template>
  <div class="card">
    <div class="page-heading">
      <h3>财务记录</h3>
      <el-button @click="list.load">刷新</el-button>
    </div>
    <p class="form-help">报名取消或被删除后，收款、退款及发票仍通过独立财务记录处理。</p>
    <el-alert v-if="list.error.value" :title="list.error.value" type="error" />
    <el-table :data="list.items.value"
      ><el-table-column label="活动" min-width="220"
        ><template #default="{ row }">{{ row.contest.title }}</template></el-table-column
      >
      <el-table-column label="报名编号" width="110"
        ><template #default="{ row }">#{{ row.number || '未提交' }}</template></el-table-column
      >
      <el-table-column label="状态" width="130"
        ><template #default="{ row }"
          ><el-tag :type="row.cancelledAt ? 'info' : 'success'">{{
            row.cancelledAt ? '报名已删除' : '报名保留中'
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="应收" width="120"
        ><template #default="{ row }">{{ money(row.feeCents) }}</template></el-table-column
      ><el-table-column label="净到账" width="120"
        ><template #default="{ row }">{{ money(row.netPaidCents) }}</template></el-table-column
      >
      <el-table-column label="创建时间" min-width="160"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      ><el-table-column label="操作" width="130"
        ><template #default="{ row }"
          ><router-link :to="`/finance/${row.id}`">查看财务记录</router-link></template
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
</template>
