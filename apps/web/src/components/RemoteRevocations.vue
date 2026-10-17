<script setup lang="ts">
import PaginatedTable from './PaginatedTable.vue';
import { onMounted, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { api, date } from '../api';
import type { Data } from '../types';
const props = defineProps<{ contestId?: string }>();
const rows = ref<Data[]>([]);
const error = ref('');
async function load() {
  try {
    error.value = '';
    rows.value = await api(
      `/integrations/revocations${props.contestId ? `?contestId=${props.contestId}` : ''}`,
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : '撤权待办加载失败';
  }
}
async function complete(row: Data) {
  await ElMessageBox.confirm(
    '请确认已在外接平台撤销对应账号／队伍的参加权限。这里只记录人工处理结果。',
    '确认远端撤权',
  );
  await api(`/integrations/revocations/${row.id}/complete`, 'POST');
  await load();
}
onMounted(load);
defineExpose({ refresh: load });
</script>
<template>
  <el-alert v-if="error" :title="error" type="error" :closable="false"
    ><el-button @click="load">重试</el-button></el-alert
  >
  <div class="card">
    <div class="page-heading">
      <h3>外接平台撤权待办</h3>
      <el-button @click="load">刷新</el-button>
    </div>
    <p class="form-help">报名已从本站删除。请在对应外接平台处理账号或队伍权限，完成后登记结果。</p>
    <PaginatedTable page-key="remoterevocations-rows" :data="rows"
      ><el-table-column label="外接平台" min-width="220"
        ><template #default="{ row }"
          ><span>{{ row.target?.platformName || row.bindingId }}</span>
          <p v-if="row.target?.remoteContestId" class="muted">
            目标：{{ row.target.remoteContestId }}
          </p></template
        ></el-table-column
      ><el-table-column prop="remoteUserId" label="远端账号" /><el-table-column
        prop="remoteTeamId"
        label="远端队伍"
      /><el-table-column label="创建时间"
        ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
      ><el-table-column label="状态"
        ><template #default="{ row }">{{
          row.state === 'COMPLETED' ? '已人工确认撤权' : '待远端撤权'
        }}</template></el-table-column
      ><el-table-column label="操作" min-width="200"
        ><template #default="{ row }"
          ><el-button v-if="row.state === 'PENDING'" text type="primary" @click="complete(row)"
            >已在外接平台完成撤权</el-button
          ></template
        ></el-table-column
      ></PaginatedTable
    >
  </div>
</template>
