import { computed, ref, onScopeDispose, type Ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { ElMessageBox } from 'element-plus';
const sessions = new Set<{ mayLeave: () => Promise<boolean>; cancel: () => void }>();
export async function mayLeaveEdits() {
  const active = [...sessions];
  for (const session of active) if (!(await session.mayLeave())) return false;
  for (const session of active) session.cancel();
  return true;
}
export function useEditSession<T extends object | undefined>(
  model: Ref<T> | T,
  initiallyEditing = false,
) {
  const editing = ref(initiallyEditing),
    baseline = ref('');
  const value = () =>
    model && typeof model === 'object' && 'value' in model ? (model as Ref<T>).value : model;
  function begin() {
    baseline.value = JSON.stringify(value());
    editing.value = true;
  }
  if (initiallyEditing) baseline.value = JSON.stringify(value());
  const dirty = computed(
    () => editing.value && !!baseline.value && JSON.stringify(value()) !== baseline.value,
  );
  function checkpoint(saved?: unknown) {
    baseline.value = JSON.stringify(saved ?? value());
  }
  function finish() {
    editing.value = false;
    baseline.value = '';
  }
  function cancel() {
    if (baseline.value) {
      const saved = JSON.parse(baseline.value);
      if (model && typeof model === 'object' && 'value' in model) (model as Ref<T>).value = saved;
      else if (model) {
        for (const key of Object.keys(model)) delete (model as any)[key];
        Object.assign(model, saved);
      }
    }
    finish();
  }
  async function mayLeave() {
    if (!dirty.value) return true;
    try {
      await ElMessageBox.confirm('有未保存的修改，确定离开并放弃修改？', '未保存修改', {
        confirmButtonText: '放弃并离开',
        cancelButtonText: '继续编辑',
        type: 'warning',
      });
      return true;
    } catch {
      return false;
    }
  }
  onBeforeRouteLeave(mayLeave);
  onBeforeRouteUpdate(mayLeave);
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty.value) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  onScopeDispose(() => window.removeEventListener('beforeunload', beforeUnload));
  const guard = { mayLeave, cancel };
  sessions.add(guard);
  onScopeDispose(() => sessions.delete(guard));
  return { editing, dirty, begin, cancel, finish, mayLeave, checkpoint };
}
