<script setup lang="ts">
import type { useEditSession } from '../composables/useEditSession';
withDefaults(
  defineProps<{ session: ReturnType<typeof useEditSession>; allow?: boolean; label?: string }>(),
  { allow: true },
);
</script>
<template>
  <div v-if="allow !== false" class="edit-actions toolbar">
    <el-button v-if="!session.editing.value" type="primary" plain @click="session.begin">{{
      label || '编辑'
    }}</el-button>
    <template v-else
      ><el-tag type="info">{{ session.dirty.value ? '有未保存修改' : '编辑中' }}</el-tag
      ><el-button @click="session.cancel">取消修改</el-button></template
    >
  </div>
</template>
