<script setup lang="ts">
defineProps<{ total: number; loading?: boolean }>();
const page = defineModel<number>('page', { required: true });
const size = defineModel<number>('size', { required: true });
</script>
<template>
  <div class="list-pagination">
    <el-pagination
      v-model:current-page="page"
      v-model:page-size="size"
      :page-sizes="[20, 50, 100]"
      :total="total"
      :disabled="loading"
      layout="total, sizes, prev, pager, next, jumper"
    />
  </div>
</template>
