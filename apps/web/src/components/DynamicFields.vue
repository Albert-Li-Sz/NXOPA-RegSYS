<script setup lang="ts">
import { computed } from 'vue';
import { fieldVisible } from '@contest-center/contracts';
import type { FieldDefinition, Data } from '../types';
import { upload } from '../api';
const props = defineProps<{
  fields: FieldDefinition[];
  scope: FieldDefinition['scope'];
  answers: Data;
  registrationId?: string;
  disabled?: boolean;
  prefix?: string;
}>();
const visible = computed(() =>
  props.fields.filter((f) => f.scope === props.scope && fieldVisible(f, props.answers)),
);
async function file(e: Event, key: string) {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) {
    const result = await upload(input.files[0], props.registrationId);
    props.answers[key] = result.id;
  }
}
</script>
<template>
  <div class="form-grid">
    <el-form-item
      v-for="f in visible"
      :key="f.key"
      :label="f.label"
      :required="f.required"
      :for="`${prefix || scope}-${f.key}`"
    >
      <div style="width: 100%">
        <el-input
          v-if="f.type === 'text' || f.type === 'textarea'"
          :id="`${prefix || scope}-${f.key}`"
          v-model="answers[f.key]"
          :type="f.type === 'textarea' ? 'textarea' : 'text'"
          :rows="3"
          :maxlength="f.max || 1000"
          :disabled="disabled"
          :placeholder="`请填写${f.label}`"
        />
        <el-input-number
          v-else-if="f.type === 'number'"
          :id="`${prefix || scope}-${f.key}`"
          v-model="answers[f.key]"
          :min="f.min"
          :max="f.max"
          :disabled="disabled"
        />
        <el-date-picker
          v-else-if="f.type === 'date'"
          :id="`${prefix || scope}-${f.key}`"
          v-model="answers[f.key]"
          type="date"
          value-format="YYYY-MM-DD"
          :disabled="disabled"
          style="width: 100%"
        />
        <el-select
          v-else-if="f.type === 'select' || f.type === 'multiselect'"
          :id="`${prefix || scope}-${f.key}`"
          v-model="answers[f.key]"
          :multiple="f.type === 'multiselect'"
          :disabled="disabled"
          placeholder="请选择"
          style="width: 100%"
          filterable
          ><el-option
            v-for="o in f.key === 'gender' ? ['男', '女'] : f.options"
            :key="o"
            :label="o"
            :value="o"
        /></el-select>
        <el-switch
          v-else-if="f.type === 'boolean'"
          :id="`${prefix || scope}-${f.key}`"
          v-model="answers[f.key]"
          :disabled="disabled"
        />
        <template v-else
          ><a v-if="answers[f.key]" :href="`/api/v1/files/${answers[f.key]}`" target="_blank"
            >查看已上传文件</a
          ><input
            :id="`${prefix || scope}-${f.key}`"
            type="file"
            :accept="f.type === 'photo' ? 'image/png,image/jpeg' : '.pdf,.png,.jpg,.jpeg,.txt'"
            :disabled="disabled"
            @change="file($event, f.key)"
          /><span class="form-help">支持 PDF、PNG、JPEG，单个文件不超过 10 MB</span></template
        >
        <div v-if="f.help" class="form-help">{{ f.help }}</div>
      </div>
    </el-form-item>
  </div>
</template>
