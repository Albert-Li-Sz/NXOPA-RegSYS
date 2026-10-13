<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import DOMPurify from 'dompurify';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import type { Data } from '../types';
const templates = ref<Data[]>([]),
  key = ref('AUTH_VERIFY'),
  busy = ref(false);
const current = computed(() => templates.value.find((t) => t.key === key.value));
const preview = computed(() =>
  DOMPurify.sanitize(
    String(current.value?.html || '').replace(
      /{{\s*(\w+)\s*}}/g,
      (_m, k) =>
        ({
          siteName: '竞赛报名系统',
          subject: '审核结果',
          message: '您的申请已通过审核。',
          code: '123456',
          actionUrl: '#',
          name: '测试同学',
          status: '通过',
        })[k as 'subject'] || '',
    ),
  ),
);
async function load() {
  templates.value = await api('/admin/mail/templates');
}
async function save() {
  if (!current.value) return;
  busy.value = true;
  try {
    await api(`/admin/mail/templates/${key.value}`, 'PUT', current.value);
    await load();
    ElMessage.success('邮件模板已保存');
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="card">
    <h3>邮件完整格式</h3>
    <p class="form-help">
      可使用变量：<code v-pre
        >{{ siteName }} {{ subject }} {{ message }} {{ actionUrl }} {{ code }} {{ name }}
        {{ status }}</code
      >。变量在 HTML 中自动转义。
    </p>
    <el-select v-model="key" aria-label="邮件类型" style="width: 100%; max-width: 400px"
      ><el-option
        v-for="template in templates"
        :key="template.key"
        :value="template.key"
        :label="template.label" /></el-select
    ><el-form v-if="current" label-position="top" style="margin-top: 20px" @submit.prevent="save"
      ><el-form-item label="启用该类邮件"><el-switch v-model="current.enabled" /></el-form-item
      ><el-form-item label="邮件标题"><el-input v-model="current.subject" /></el-form-item
      ><el-form-item label="纯文本内容"
        ><el-input v-model="current.text" type="textarea" :rows="6" /></el-form-item
      ><el-form-item label="HTML 完整内容"
        ><el-input
          v-model="current.html"
          type="textarea"
          :rows="10"
          class="code-input" /></el-form-item
      ><el-button type="primary" native-type="submit" :loading="busy"
        >保存邮件模板</el-button
      ></el-form
    >
  </div>
  <div class="card">
    <h3>HTML 预览</h3>
    <iframe
      title="邮件模板预览"
      :srcdoc="preview"
      sandbox=""
      style="width: 100%; height: 400px; border: 1px solid #ebeef2; border-radius: 8px"
    />
  </div>
</template>
