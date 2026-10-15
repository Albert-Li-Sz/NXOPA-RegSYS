<script setup lang="ts">
import { watch } from 'vue';
import ListPagination from './ListPagination.vue';
import { useLocalPagination } from '../composables/useLocalPagination';
const props = withDefaults(
  defineProps<{ items: any[]; pageKey: string; always?: boolean; startAtEnd?: boolean }>(),
  { always: true },
);
const list = useLocalPagination(props.pageKey, () => props.items ?? []);
if (props.startAtEnd)
  list.page.value = Math.max(1, Math.ceil(list.total.value / list.pageSize.value));
watch(
  () => props.items.length,
  (count, previous) => {
    if (
      props.startAtEnd &&
      list.page.value >= Math.max(1, Math.ceil(previous / list.pageSize.value))
    )
      list.page.value = Math.max(1, Math.ceil(count / list.pageSize.value));
  },
);
</script>
<template>
  <div class="paginated-list" :data-pagination-key="pageKey">
    <slot :items="list.items.value" :entries="list.entries.value" />
    <ListPagination
      v-if="always || list.total.value > 20"
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
    />
  </div>
</template>
