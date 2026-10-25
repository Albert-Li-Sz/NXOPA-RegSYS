<script setup lang="ts">
import { computed } from 'vue';
import {
  minimumEnrollmentYear,
  maximumEnrollmentYear,
  normalizeEnrollmentYear,
} from '@contest-center/contracts';
const props = defineProps<{ modelValue?: unknown; id?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: number | undefined] }>();
// Numeric values are milliseconds to the date picker; use a YYYY string on its boundary.
const value = computed({
  get: () => {
    const year = normalizeEnrollmentYear(props.modelValue);
    return year === undefined ? '' : String(year);
  },
  set: (next: string | null) => emit('update:modelValue', normalizeEnrollmentYear(next)),
});
const disabledDate = (date: Date) =>
  date.getFullYear() < minimumEnrollmentYear || date.getFullYear() > maximumEnrollmentYear();
</script>
<template>
  <el-date-picker
    :id="id"
    v-model="value"
    type="year"
    format="YYYY"
    value-format="YYYY"
    :editable="false"
    :disabled="disabled"
    :disabled-date="disabledDate"
    placeholder="请选择入学年份"
    style="width: 100%"
  />
</template>
