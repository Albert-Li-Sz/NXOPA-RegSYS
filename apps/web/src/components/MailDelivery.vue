<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, date, label } from '../api';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
const props = defineProps<{ resourceId: string }>();
const list = usePagedList(
  'mail-delivery',
  () => `/notifications/mail?resourceId=${props.resourceId}`,
);
const rows = list.items,
  loading = list.loading,
  error = list.error;
async function refresh() {
  await list.load();
}
async function retry(id: string) {
  await api(`/notifications/mail/${id}/retry`, 'POST');
  ElMessage.success('邮件已加入重发队列');
  await refresh();
}
onMounted(refresh);
watch(
  () => props.resourceId,
  () => {
    if (list.page.value === 1) void refresh();
    else list.page.value = 1;
  },
);
</script>
<template>
  <div class="card mail-delivery" data-pagination-key="mail-delivery">
    <div class="member-heading">
      <h3>邮件推送情况</h3>
      <el-button :loading="loading" @click="refresh">刷新</el-button>
    </div>
    <p class="form-help">发送成功表示邮件服务器已接收。验证码失效时请重新申请验证码。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table :data="rows" v-loading="loading" empty-text="暂无邮件通知">
      <el-table-column prop="subject" label="通知" min-width="180" />
      <el-table-column prop="to" label="收件人" min-width="180" />
      <el-table-column label="推送状态" width="110"
        ><template #default="{ row }"
          ><el-tag
            :type="row.state === 'FAILED' ? 'danger' : row.state === 'SUCCESS' ? 'success' : 'info'"
            >{{ row.state === 'SUCCESS' ? '已发送' : label(row.state) }}</el-tag
          ></template
        ></el-table-column
      >
      <el-table-column label="时间" width="170"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      >
      <el-table-column label="说明 / 操作" min-width="180"
        ><template #default="{ row }"
          ><span class="form-help">{{ row.error || '' }}</span
          ><el-button v-if="row.canRetry" text type="primary" @click="retry(row.id)"
            >重发</el-button
          ></template
        ></el-table-column
      >
    </el-table>
    <ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
      :loading="loading"
    />
  </div>
</template>
