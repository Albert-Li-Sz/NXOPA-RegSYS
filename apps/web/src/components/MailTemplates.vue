<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import DOMPurify from 'dompurify';
import { ElMessage } from 'element-plus';
import {
  renderMailTemplate,
  mailTemplateForCategory,
  mailTemplateExample,
  authenticationMailCategories,
  type MailTemplateContext,
} from '@contest-center/contracts';
import { api, auth } from '../api';
import type { Data } from '../types';
const templates = ref<Data[]>([]),
  originals = ref<Record<string, string>>({}),
  key = ref('AUTH_VERIFY'),
  busy = ref(false),
  saveError = ref(''),
  testing = ref(false),
  testResult = ref('');
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
const site = ref({ name: '竞赛报名系统', publicUrl: window.location.origin });
const context = computed<MailTemplateContext>(() => {
  const example = mailTemplateExample(key.value);
  return {
    siteName: site.value.name,
    subject: example.subject,
    message: example.text,
    code: example.code ?? '',
    actionUrl: `${site.value.publicUrl.replace(/\/$/, '')}${example.actionPath}`,
    name: auth.user?.name || '测试管理员',
    status: example.status,
  };
});
const current = computed(() => templates.value.find((t) => t.key === key.value));
const dirty = computed(
  () => current.value && JSON.stringify(current.value) !== originals.value[key.value],
);
const rendered = computed(() =>
  current.value
    ? renderMailTemplate(
        { subject: current.value.subject, text: current.value.text, html: current.value.html },
        context.value,
        key.value,
      )
    : { subject: '', text: '', html: '' },
);
const preview = computed(() =>
  DOMPurify.sanitize(rendered.value.html, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'] }),
);
async function load() {
  templates.value = await api('/admin/mail/templates');
  originals.value = Object.fromEntries(
    templates.value.map((row) => [row.key, JSON.stringify(row)]),
  );
}
async function save() {
  if (!current.value) return;
  busy.value = true;
  saveError.value = '';
  try {
    const target = current.value;
    const saved = await api(`/admin/mail/templates/${target.key}`, 'PUT', target);
    const result = { ...saved, label: target.label };
    const index = templates.value.findIndex((row) => row.key === target.key);
    templates.value[index] = result;
    originals.value[target.key] = JSON.stringify(result);
    ElMessage.success('邮件模板已保存');
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : '邮件模板保存失败';
  } finally {
    busy.value = false;
  }
}
function discard() {
  const index = templates.value.findIndex((row) => row.key === key.value);
  if (index >= 0) templates.value[index] = JSON.parse(originals.value[key.value]!);
  saveError.value = '';
}
function defaults() {
  if (current.value)
    Object.assign(current.value, mailTemplateForCategory(key.value), { enabled: true });
}
async function testMail() {
  if (!current.value) return;
  testing.value = true;
  try {
    const target = current.value;
    const result = await api(`/admin/mail/templates/${target.key}/test`, 'POST', {
      version: target.version,
    });
    testResult.value = `${target.label} 测试邮件已排队，接收邮箱：${result.to}`;
    const deadline = Date.now() + 90000;
    while (alive && Date.now() < deadline) {
      const job = await api(`/admin/mail/templates/tests/${result.jobId}`);
      if (job.state === 'SUCCESS') {
        testResult.value = `${target.label} 测试邮件发送成功（${job.result?.providerName || '主 SMTP'}）`;
        return;
      }
      if (job.state === 'FAILED' && job.attempts >= 4) {
        testResult.value = `模板测试邮件失败：${job.error}`;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (alive) testResult.value = '模板测试邮件仍在处理，可在日志与任务中心查看。';
  } catch (e) {
    testResult.value = e instanceof Error ? e.message : '模板测试失败';
  } finally {
    testing.value = false;
  }
}
onMounted(async () => {
  await load();
  site.value = await api('/site');
});
</script>
<template>
  <div class="card">
    <h3>邮件完整格式</h3>
    <p class="form-help">
      可使用变量：<code v-pre
        >{{ siteName }} {{ subject }} {{ message }} {{ actionUrl }} {{ code }} {{ name }}
        {{ status }}</code
      >。变量在 HTML 中自动转义。可用 <code v-pre>{{#code}}…{{/code}}</code> 和
      <code v-pre>{{#actionUrl}}…{{/actionUrl}}</code> 隐藏空值区块。
    </p>
    <el-select v-model="key" aria-label="邮件类型" filterable style="width: 100%; max-width: 400px"
      ><el-option
        v-for="template in templates"
        :key="template.key"
        :value="template.key"
        :label="template.label"
    /></el-select>
    <el-form
      v-if="current"
      label-position="top"
      :disabled="busy"
      style="margin-top: 20px"
      @submit.prevent="save"
    >
      <el-form-item label="启用该类邮件"
        ><el-switch
          v-model="current.enabled"
          :disabled="authenticationMailCategories.includes(key)"
        /><span v-if="authenticationMailCategories.includes(key)" class="form-help"
          >验证类邮件必须启用，并保留验证码变量。</span
        ></el-form-item
      >
      <el-form-item label="邮件标题" for="template-subject"
        ><el-input id="template-subject" v-model="current.subject"
      /></el-form-item>
      <el-form-item label="纯文本内容" for="template-text"
        ><el-input id="template-text" v-model="current.text" type="textarea" :rows="6"
      /></el-form-item>
      <el-form-item label="HTML 完整内容" for="template-html"
        ><el-input
          id="template-html"
          v-model="current.html"
          type="textarea"
          :rows="10"
          class="code-input"
      /></el-form-item>
      <div class="actions">
        <el-button type="primary" native-type="submit" :loading="busy" :disabled="!dirty || testing"
          >保存邮件模板</el-button
        >
        <el-button :disabled="busy || !dirty" @click="discard">撤销当前修改</el-button>
        <el-button :disabled="busy" @click="defaults">恢复默认格式</el-button>
        <el-button
          :disabled="busy || dirty || !current.enabled"
          :loading="testing"
          @click="testMail"
          >发送模板测试邮件</el-button
        >
        <span class="form-help">{{
          dirty ? '当前模板有未保存修改；切换类型会保留草稿。' : '当前模板已保存'
        }}</span>
      </div>
    </el-form>
    <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" />
    <el-alert v-if="testResult" :title="testResult" type="info" :closable="false" />
  </div>
  <div class="card">
    <h3>HTML 预览</h3>
    <p class="form-help">标题：{{ rendered.subject }}</p>
    <iframe
      title="邮件模板预览"
      :srcdoc="preview"
      sandbox=""
      style="width: 100%; height: 400px; border: 1px solid #ebeef2; border-radius: 8px"
    />
    <h3 style="margin-top: 20px">纯文本预览</h3>
    <pre class="template-text-preview">{{ rendered.text }}</pre>
  </div>
</template>
<style scoped>
.template-text-preview {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #f5f7fa;
  padding: 16px;
  border-radius: 6px;
}
</style>
