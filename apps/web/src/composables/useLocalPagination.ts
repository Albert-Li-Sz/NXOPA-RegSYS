import { computed, ref, watch } from 'vue';
export function useLocalPagination<T>(key: string, source: () => T[]) {
  const stored = Number(localStorage.getItem(`page-size:${key}`));
  const page = ref(1),
    pageSize = ref([20, 50, 100].includes(stored) ? stored : 20);
  const total = computed(() => source().length);
  const offset = computed(() => (page.value - 1) * pageSize.value);
  const items = computed(() => source().slice(offset.value, offset.value + pageSize.value));
  const entries = computed(() =>
    items.value.map((row, index) => ({ row, index: offset.value + index })),
  );
  watch(
    [total, pageSize],
    () => {
      page.value = Math.min(page.value, Math.max(1, Math.ceil(total.value / pageSize.value)));
    },
    { flush: 'sync' },
  );
  watch(
    pageSize,
    (size) => {
      localStorage.setItem(`page-size:${key}`, String(size));
      page.value = 1;
    },
    { flush: 'sync' },
  );
  return { page, pageSize, total, items, entries, offset, reset: () => (page.value = 1) };
}
