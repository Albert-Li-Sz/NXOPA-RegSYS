<script setup lang="ts">
import { ref } from 'vue';
import { InfoFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, auth } from '../api';
import { discardEdits } from '../composables/useEditSession';
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
const busy = ref(false),
  reasonHovered = ref(false),
  reasonFocused = ref(false);
async function remove() {
  if (busy.value || props.contest.deletion?.allowed === false) return;
  busy.value = true;
  try {
    if (props.beforeRemove && !(await props.beforeRemove())) return;
    await ElMessageBox.confirm(
      `永久删除「${props.contest.title}」？仅无报名、无财务记录的活动可删除。活动配置及考场将被清理；已上传文件转为上传者私有文件，独立工单继续保留。此操作不可恢复。`,
      '删除活动及竞赛',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    );
    await api(`/contests/${props.contest.id}`, 'DELETE', { version: props.contest.version });
    if (props.beforeRemove) discardEdits();
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
  <span v-if="auth.user?.isAdmin" class="action-control contest-delete-control">
    <el-button
      :text="text"
      type="danger"
      :disabled="contest.deletion?.allowed === false"
      :loading="busy"
      @click="remove"
      >{{ text ? '删除' : '删除活动' }}</el-button
    >
    <el-tooltip
      v-if="text && contest.deletion?.allowed === false"
      :content="contest.deletion.reason"
      placement="top"
      :visible="reasonHovered || reasonFocused"
    >
      <button
        type="button"
        class="delete-reason"
        :aria-label="contest.deletion.reason"
        @mouseenter="reasonHovered = true"
        @mouseleave="reasonHovered = false"
        @focus="reasonFocused = true"
        @blur="reasonFocused = false"
      >
        <el-icon><InfoFilled /></el-icon>
      </button>
    </el-tooltip>
  </span>
</template>
<style scoped>
.contest-delete-control {
  gap: 4px;
}
.delete-reason {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: #909399;
  padding: 2px;
  width: 20px;
  height: 24px;
  cursor: help;
}
.delete-reason:focus-visible {
  outline: 2px solid #1765c1;
  border-radius: 50%;
}
</style>
