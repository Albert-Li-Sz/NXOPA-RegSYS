<script setup lang="ts">
import { computed, ref, onScopeDispose, watch } from 'vue';
import { fieldVisible } from '@contest-center/contracts';
import type { FieldDefinition, Data } from '../types';
import { upload } from '../api';
import PaginatedList from './PaginatedList.vue';
import { beginOperation } from '../composables/usePendingOperations';
import YearSelect from './YearSelect.vue';
import InstitutionSelect from './InstitutionSelect.vue';
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
const uploading = ref<Record<string, boolean>>({});
const uploadError = ref<Record<string, string>>({});
let generation = 0;
watch(
  () => [props.answers, props.registrationId, props.disabled],
  () => generation++,
);
onScopeDispose(() => generation++);
async function file(e: Event, key: string) {
  const input = e.target as HTMLInputElement;
  const selected = input.files?.[0];
  if (!selected || props.disabled || uploading.value[key]) return;
  const answers = props.answers,
    current = generation,
    end = beginOperation();
  uploading.value[key] = true;
  uploadError.value[key] = '';
  try {
    const result = await upload(selected, props.registrationId);
    if (current === generation && answers === props.answers && !props.disabled)
      answers[key] = result.id;
  } catch (error) {
    if (current === generation)
      uploadError.value[key] = error instanceof Error ? error.message : '上传失败，请重试';
  } finally {
    uploading.value[key] = false;
    input.value = '';
    end();
  }
}
</script>
<template>
  <PaginatedList
    :items="visible"
    :page-key="`dynamic-fields-${scope}`"
    :always="false"
    v-slot="{ items }"
  >
    <div class="form-grid">
      <el-form-item
        v-for="f in items"
        :key="f.key"
        :label="f.label"
        :required="f.required"
        :for="`${prefix || scope}-${f.key}`"
      >
        <div style="width: 100%">
          <el-input
            v-if="f.type === 'text' || f.type === 'textarea' || f.type === 'email'"
            :id="`${prefix || scope}-${f.key}`"
            v-model="answers[f.key]"
            :type="f.type === 'textarea' ? 'textarea' : f.type === 'email' ? 'email' : 'text'"
            :rows="3"
            :maxlength="f.max ?? (f.type === 'textarea' ? 10000 : 1000)"
            :disabled="disabled"
            :placeholder="`请填写${f.label}`"
          />
          <YearSelect
            v-else-if="f.type === 'year'"
            :id="`${prefix || scope}-${f.key}`"
            v-model="answers[f.key]"
            :disabled="disabled"
          />
          <InstitutionSelect
            v-else-if="f.type === 'institution'"
            :id="`${prefix || scope}-${f.key}`"
            v-model="answers[f.key]"
            :disabled="disabled"
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
            ><a
              v-if="answers[f.key]"
              :href="`/api/v1/files/${answers[f.key]}`"
              target="_blank"
              rel="noopener"
              >查看已上传文件</a
            ><input
              :id="`${prefix || scope}-${f.key}`"
              type="file"
              :accept="f.type === 'photo' ? 'image/png,image/jpeg' : '.pdf,.png,.jpg,.jpeg,.txt'"
              :disabled="disabled || uploading[f.key]"
              @change="file($event, f.key)"
            /><span v-if="uploading[f.key]" role="status">附件正在上传…</span
            ><span v-if="uploadError[f.key]" role="alert">{{ uploadError[f.key] }}</span
            ><span class="form-help">支持 PDF、PNG、JPEG，单个文件不超过 10 MB</span></template
          >
          <div v-if="f.help" class="form-help">{{ f.help }}</div>
        </div>
      </el-form-item>
    </div>
  </PaginatedList>
</template>
