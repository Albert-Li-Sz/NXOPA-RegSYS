<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { TableInstance } from 'element-plus';
import ListPagination from './ListPagination.vue';
import { useLocalPagination } from '../composables/useLocalPagination';
import type { Data } from '../types';
defineOptions({ inheritAttrs: false });
const props = defineProps<{ data: Data[]; pageKey: string; filterKey?: unknown }>();
const list = useLocalPagination(props.pageKey, () => props.data ?? []);
const table = ref<TableInstance>();
const keys = new WeakMap<object, number>();
let nextKey = 0;
function rowKey(row: Data) {
  if (row.id !== undefined) return row.id;
  if (row.unitKey !== undefined) return row.unitKey;
  if (row.key !== undefined) return `${row.scope ?? ''}:${row.key}`;
  if (!keys.has(row)) keys.set(row, ++nextKey);
  return keys.get(row)!;
}
watch(() => props.filterKey, list.reset);
watch(
  () => props.data,
  async () => {
    await nextTick();
    const current = new Set((props.data ?? []).map(rowKey));
    for (const row of table.value?.getSelectionRows() ?? [])
      if (!current.has(rowKey(row))) table.value?.toggleRowSelection(row, false);
  },
);
</script>
<template>
  <div class="paginated-table" :data-pagination-key="pageKey">
    <el-table ref="table" v-bind="$attrs" :data="list.items.value" :row-key="rowKey">
      <template v-for="(_, name) in $slots" #[name]="scope"
        ><slot :name="name" v-bind="scope ?? {}"
      /></template>
    </el-table>
    <ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
    />
  </div>
</template>
