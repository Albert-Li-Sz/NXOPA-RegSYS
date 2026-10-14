<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { MailSettingsInput, MailSettingsView } from '@contest-center/contracts';
import { mailSettingsSchema } from '@contest-center/contracts';
import { api, auth } from '../api';
import { requestId } from '../request-id';
import SmtpServerFields from './SmtpServerFields.vue';
const form = ref<MailSettingsInput>(),
  saved = ref(''),
  source = ref(''),
  passwordConfigured = ref(false),
  fallbackConfigured = ref<Record<string, boolean>>({}),
  loading = ref(false),
  saving = ref(false),
  probing = ref(false),
  testing = ref(false),
  probeResult = ref(''),
  probeOk = ref(false),
  testResult = ref('');
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
const dirty = computed(() => !!form.value && JSON.stringify(form.value) !== saved.value);
function apply(value: MailSettingsView) {
  const { source: origin, passwordConfigured: configured, fallbacks, ...input } = value;
  fallbackConfigured.value = Object.fromEntries(
    (fallbacks ?? []).map((server) => [server.id, server.passwordConfigured]),
  );
  form.value = {
    ...input,
    password: '',
    fallbacks: (fallbacks ?? []).map(({ passwordConfigured, ...server }) => ({
      ...server,
      password: '',
    })),
  };
  saved.value = JSON.stringify(form.value);
  passwordConfigured.value = configured;
  source.value = origin === 'DATABASE' ? '管理中心配置' : '部署环境配置';
  probeResult.value = '';
  testResult.value = '';
}
function addFallback() {
  form.value?.fallbacks.push({
    id: requestId(),
    name: `备用 SMTP ${form.value.fallbacks.length + 1}`,
    enabled: true,
    host: '',
    port: 587,
    security: 'STARTTLS',
    authEnabled: true,
    username: '',
    password: '',
    fromAddress: form.value.fromAddress,
    fromName: form.value.fromName,
  });
}
function moveFallback(index: number, offset: number) {
  if (!form.value) return;
  const next = index + offset;
  if (next < 0 || next >= form.value.fallbacks.length) return;
  [form.value.fallbacks[index], form.value.fallbacks[next]] = [
    form.value.fallbacks[next]!,
    form.value.fallbacks[index]!,
  ];
}
async function probeFallback(id: string) {
  probing.value = true;
  try {
    const result = await api('/admin/mail/probe', 'POST', {
      version: form.value!.version,
      providerId: id,
    });
    ElMessage.success(result.message);
  } finally {
    probing.value = false;
  }
}
async function load() {
  loading.value = true;
  try {
    apply(await api<MailSettingsView>('/admin/mail'));
  } finally {
    loading.value = false;
  }
}
async function save() {
  const parsed = mailSettingsSchema.safeParse(form.value);
  if (!parsed.success) {
    ElMessage.warning('请检查服务器地址、端口和发件邮箱是否填写正确');
    return;
  }
  saving.value = true;
  try {
    apply(await api<MailSettingsView>('/admin/mail', 'PUT', parsed.data));
    ElMessage.success('邮件设置已保存，后续邮件任务立即使用新配置');
  } finally {
    saving.value = false;
  }
}
async function probe() {
  probing.value = true;
  probeResult.value = '';
  try {
    const result = await api('/admin/mail/probe', 'POST', { version: form.value!.version });
    probeOk.value = true;
    probeResult.value = result.message;
  } catch (error) {
    probeOk.value = false;
    probeResult.value = (error as Error).message;
  } finally {
    probing.value = false;
  }
}
async function testMail() {
  testing.value = true;
  try {
    const result = await api('/admin/mail/test', 'POST', { version: form.value!.version });
    testResult.value = `测试邮件已加入队列，接收邮箱：${result.to}`;
    const deadline = Date.now() + 90000;
    while (alive && Date.now() < deadline) {
      const job = await api(`/admin/mail/tests/${result.jobId}`);
      if (job.state === 'SUCCESS') {
        testResult.value = `测试邮件发送成功（${job.result?.providerName || '主 SMTP'}），请在 ${result.to} 检查收件箱或垃圾邮件。`;
        return;
      }
      if (job.state === 'FAILED' && job.attempts >= 4) {
        testResult.value = `测试邮件发送失败：${job.error}`;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (alive) testResult.value = '测试邮件仍在处理，可在“任务”页查看发送状态和失败原因。';
  } catch (error) {
    testResult.value = (error as Error).message;
  } finally {
    testing.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="card mail-settings" v-loading="loading">
    <div class="page-heading">
      <div>
        <h3>系统邮件设置</h3>
        <p class="subtitle">用于邮箱验证、密码找回，以及报名、财务和工单通知。</p>
      </div>
      <el-tag v-if="form" type="info">{{ source }} · 版本 {{ form.version }}</el-tag>
    </div>
    <el-form v-if="form" label-position="top" @submit.prevent="save">
      <el-form-item label="邮件服务" for="mail-enabled">
        <el-switch id="mail-enabled" v-model="form.enabled" active-text="启用邮件服务" />
      </el-form-item>
      <h4>主 SMTP · 第 1 顺序</h4>
      <SmtpServerFields :server="form" :password-configured="passwordConfigured" />
      <div class="page-heading">
        <div>
          <h4>备用 SMTP</h4>
          <p class="form-help">
            主 SMTP 失败后，按下方顺序尝试已启用的备用服务器，发送成功即停止。
          </p>
        </div>
        <el-button :disabled="saving || form.fallbacks.length >= 10" @click="addFallback"
          >新增备用 SMTP</el-button
        >
      </div>
      <section
        v-for="(server, index) in form.fallbacks"
        :key="server.id"
        class="smtp-fallback card"
      >
        <div class="page-heading">
          <strong>第 {{ index + 2 }} 顺序</strong>
          <div class="button-group">
            <el-button :disabled="index === 0 || saving" @click="moveFallback(index, -1)"
              >上移</el-button
            ><el-button
              :disabled="index === form.fallbacks.length - 1 || saving"
              @click="moveFallback(index, 1)"
              >下移</el-button
            ><el-button
              type="danger"
              plain
              :disabled="saving"
              @click="form.fallbacks.splice(index, 1)"
              >移除</el-button
            >
          </div>
        </div>
        <div class="form-grid">
          <el-form-item label="SMTP 名称" :for="`smtp-${server.id}-name`"
            ><el-input :id="`smtp-${server.id}-name`" v-model="server.name" /></el-form-item
          ><el-form-item label="启用备用服务器"
            ><el-switch v-model="server.enabled"
          /></el-form-item>
        </div>
        <SmtpServerFields
          :server="server"
          :prefix="`smtp-${server.id}`"
          :password-configured="fallbackConfigured[server.id]"
        />
        <el-button
          :disabled="dirty || !server.enabled || !form.enabled || saving || testing"
          :loading="probing"
          @click="probeFallback(server.id)"
          >检测此备用连接</el-button
        >
      </section>
      <p class="muted">
        密码加密保存，编辑时留空保留原值。关闭服务器认证并保存会清除认证密码。更换认证用户名时请重新填写密码。
      </p>
      <p v-if="dirty" class="muted">配置尚未保存，请先保存再检测或发送测试邮件。</p>
      <div class="actions">
        <el-button
          type="primary"
          native-type="submit"
          :loading="saving"
          :disabled="probing || testing"
          >保存邮件设置</el-button
        >
        <el-button
          :loading="probing"
          :disabled="dirty || !form.enabled || saving || testing"
          @click="probe"
          >检测连接</el-button
        >
        <el-button
          :loading="testing"
          :disabled="dirty || !form.enabled || saving || probing"
          @click="testMail"
          >发送测试邮件</el-button
        >
        <el-button :disabled="saving || probing || testing" @click="load">重新加载</el-button>
      </div>
      <el-alert
        v-if="probeResult"
        :title="probeResult"
        :type="probeOk ? 'success' : 'error'"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="testResult"
        :title="testResult"
        type="info"
        :closable="false"
        show-icon
        class="mail-result"
      />
      <p class="muted">
        测试邮件发送至当前管理员邮箱：{{
          auth.user?.email
        }}。连接检测通过后，还需要检查测试邮件是否实际收到。
      </p>
    </el-form>
  </div>
</template>
<style scoped>
.mail-settings {
  max-width: 1040px;
}
.mail-settings h3 {
  margin: 0 0 8px;
}
.mail-settings .el-input-number,
.mail-settings .el-select {
  width: 100%;
}
.mail-result {
  margin-top: 12px;
}
@media (max-width: 640px) {
  .mail-settings .page-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
