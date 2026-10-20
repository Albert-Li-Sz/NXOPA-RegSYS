import { computed, onScopeDispose, ref } from 'vue';
import { ElMessage } from 'element-plus';

const pending = ref(0);
const guards = new Set<() => boolean>();
export const hasPendingOperations = computed(() => pending.value > 0);
export function beginOperation() {
  pending.value++;
  let ended = false;
  return () => {
    if (!ended) pending.value--;
    ended = true;
  };
}
export function operationsSettled() {
  if (hasPendingOperations.value) {
    ElMessage.info('附件正在上传，请稍候再保存或离开');
    return false;
  }
  return [...guards].every((guard) => guard());
}
export function useOperationGuard(guard: () => boolean) {
  guards.add(guard);
  onScopeDispose(() => guards.delete(guard));
}
