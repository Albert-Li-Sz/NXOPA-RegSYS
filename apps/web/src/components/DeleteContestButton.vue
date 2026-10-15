<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, auth } from '../api';
const props = defineProps<{
  contest: {
    id: string;
    title: string;
    version: number;
    deletion?: { allowed: boolean; reason: string };
  };
  text?: boolean;
  beforeRemove?: () => Promise<boolean>;
}>();
const emit = defineEmits<{ deleted: [] }>();
const busy = ref(false);
async function remove() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (props.beforeRemove && !(await props.beforeRemove())) return;
    await ElMessageBox.confirm(
      `永久删除「${props.contest.title}」？仅无报名、无财务记录的活动可删除。活动配置、考场及平台关联将被清理；已上传文件转为上传者私有文件，独立工单继续保留。此操作不可恢复。`,
      '删除活动及竞赛',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    );
    await api(`/contests/${props.contest.id}`, 'DELETE', { version: props.contest.version });
    ElMessage.success('活动及竞赛已删除');
    emit('deleted');
  } catch {
    // Cancellation is expected; API failures are already displayed by api().
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-tooltip
    v-if="auth.user?.isAdmin"
    :content="contest.deletion?.reason || ''"
    :disabled="contest.deletion?.allowed !== false"
  >
    <span class="action-control" :title="contest.deletion?.reason">
      <el-button
        :text="text"
        type="danger"
        :disabled="contest.deletion?.allowed === false"
        :loading="busy"
        @click="remove"
        >{{ text ? '删除' : '删除活动' }}</el-button
      >
    </span>
  </el-tooltip>
</template>
