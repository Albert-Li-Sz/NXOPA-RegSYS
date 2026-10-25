<script setup lang="ts">
import { computed, ref, onScopeDispose, watch } from 'vue';
import type { InstitutionOption, PageResult } from '@contest-center/contracts';
import { api } from '../api';
const props = defineProps<{ modelValue?: unknown; id?: string; disabled?: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  selected: [value: InstitutionOption];
}>();
const options = ref<InstitutionOption[]>([]),
  total = ref(0),
  loading = ref(false),
  error = ref('');
let generation = 0;
const selectedName = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''));
const retained = computed(
  () => selectedName.value && !options.value.some((row) => row.name === selectedName.value),
);
async function search(query = '') {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const result = await api<PageResult<InstitutionOption>>(
      `/institutions?${new URLSearchParams({ search: query, page: '1', pageSize: '50' })}`,
    );
    if (current !== generation) return;
    options.value = result.items;
    total.value = result.total;
  } catch (e) {
    if (current === generation) {
      options.value = [];
      total.value = 0;
      error.value = e instanceof Error ? e.message : '目录加载失败，请重试';
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => [props.modelValue, props.disabled],
  () => {
    if (!props.disabled) void search(selectedName.value);
  },
  { immediate: true },
);
onScopeDispose(() => generation++);
function change(name: string) {
  emit('update:modelValue', name ?? '');
  const selected = options.value.find((row) => row.name === name);
  if (selected) emit('selected', selected);
}
</script>
<template>
  <div class="institution-select">
    <el-select
      :id="id"
      :model-value="selectedName"
      @update:model-value="change"
      filterable
      remote
      clearable
      :remote-method="search"
      :loading="loading"
      :disabled="disabled"
      placeholder="搜索院校或单位"
      @visible-change="(open: boolean) => open && search('')"
      style="width: 100%"
    >
      <el-option v-if="retained" :label="selectedName" :value="selectedName" />
      <el-option v-for="row in options" :key="row.id" :label="row.name" :value="row.name">
        <span>{{ row.name }}</span
        ><span class="muted institution-location"
          >{{ row.province }} {{ row.city !== row.province ? row.city : '' }}</span
        >
      </el-option>
      <template #footer
        ><span class="form-help">{{
          total > 50
            ? `共 ${total} 条，显示前 50 条，请输入名称缩小范围。`
            : '没有所需单位时，请联系管理员添加。'
        }}</span></template
      >
    </el-select>
    <p v-if="error" class="form-help" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.institution-select {
  width: 100%;
  min-width: 0;
}
.institution-location {
  margin-left: 12px;
  font-size: 12px;
}
</style>
