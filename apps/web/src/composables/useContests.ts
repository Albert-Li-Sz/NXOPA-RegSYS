import { onMounted, ref, shallowRef } from 'vue';
import { api } from '../api';
import type { ContestView } from '../types';

export function useContests() {
  const contests = shallowRef<ContestView[]>([]),
    loading = ref(true),
    error = ref('');
  async function load() {
    loading.value = true;
    error.value = '';
    try {
      contests.value = await api('/contests');
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }
  onMounted(load);
  return { contests, loading, error, load };
}
