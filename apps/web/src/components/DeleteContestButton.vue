<script setup lang="ts">
import { ref } from 'vue';
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
const busy = ref(false);
async function remove() {
  if (busy.value || props.contest.deletion?.allowed === false) return;
  busy.value = true;
  try {
    if (props.beforeRemove && !(await props.beforeRemove())) return;
    await ElMessageBox.confirm(
      `永久删除「${props.contest.title}」？仅无报名、无财务记录的活动可删除。活动配置、考场及平台关联将被清理；已上传文件转为上传者私有文件，独立工单继续保留。此操作不可恢复。`,
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
  <span
    v-if="auth.user?.isAdmin"
    class="action-control delete-contest-control"
    :class="{ 'delete-contest-control--text': text }"
  >
    <el-button
      :text="text"
      type="danger"
      :disabled="contest.deletion?.allowed === false"
      :aria-disabled="contest.deletion?.allowed === false"
      :loading="busy"
      @click="remove"
      >{{ text ? '删除' : '删除活动' }}</el-button
    >
    <el-tooltip
      v-if="contest.deletion?.allowed === false"
      :content="contest.deletion.reason"
      :trigger="['hover', 'focus', 'click']"
      placement="top-end"
    >
      <button
        type="button"
        class="delete-reason"
        :aria-label="`无法删除：${contest.deletion.reason}`"
      >
        <span class="reason-dot" aria-hidden="true" />
      </button>
    </el-tooltip>
  </span>
</template>
<style scoped>
.delete-contest-control {
  flex-direction: row;
  align-items: center;
  gap: 2px;
}
.delete-contest-control > .el-button {
  flex: 1;
  min-width: 0;
  width: auto;
}
.delete-contest-control:not(.delete-contest-control--text) {
  position: relative;
}
.delete-contest-control:not(.delete-contest-control--text) .delete-reason {
  position: absolute;
  inset-inline-end: 4px;
  top: 50%;
  transform: translateY(-50%);
}
.delete-reason {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  width: 24px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #73767a;
  cursor: help;
}
.delete-reason:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.reason-dot {
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-radius: 50%;
}
</style>
