import { ref, watch, onScopeDispose } from 'vue';
import { api } from '../api';
import type { PageResult } from '@contest-center/contracts';
import type { Data } from '../types';

export function usePagedList<T = Data>(key: string, endpoint: () => string) {
  const stored = Number(localStorage.getItem(`page-size:${key}`));
  const page = ref(1),
    pageSize = ref([20, 50, 100].includes(stored) ? stored : 20);
  const items = ref<T[]>([]) as import('vue').Ref<T[]>;
  const total = ref(0),
    loading = ref(false),
    error = ref(''),
    filters = ref<Record<string, string>>({});
  let sequence = 0;
  function query(paged = true) {
    const params = new URLSearchParams(Object.entries(filters.value).filter(([, v]) => !!v));
    if (paged) {
      params.set('page', String(page.value));
      params.set('pageSize', String(pageSize.value));
    }
    return params.toString();
  }
  async function load() {
    const source = endpoint();
    if (!source) return;
    const current = ++sequence;
    loading.value = true;
    error.value = '';
    try {
      const result = await api<PageResult<T>>(
        `${source}${source.includes('?') ? '&' : '?'}${query()}`,
      );
      if (current !== sequence) return;
      items.value = result.items;
      total.value = result.total;
      if (page.value > 1 && page.value > Math.ceil(total.value / pageSize.value))
        page.value = Math.max(1, Math.ceil(total.value / pageSize.value));
    } catch (e) {
      if (current === sequence) error.value = e instanceof Error ? e.message : '列表加载失败';
    } finally {
      if (current === sequence) loading.value = false;
    }
  }
  watch(page, load);
  watch(pageSize, (n) => {
    localStorage.setItem(`page-size:${key}`, String(n));
    if (page.value !== 1) page.value = 1;
    else load();
  });
  let timer: ReturnType<typeof setTimeout>;
  watch(
    filters,
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (page.value !== 1) page.value = 1;
        else load();
      }, 250);
    },
    { deep: true },
  );
  onScopeDispose(() => {
    clearTimeout(timer);
    sequence++;
  });
  return { page, pageSize, items, total, loading, error, filters, load, query };
}
