<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { MailSettingsInput, MailSettingsView } from '@contest-center/contracts';
import { mailSettingsSchema } from '@contest-center/contracts';
import { api, auth } from '../api';
const form = ref<MailSettingsInput>(),
  saved = ref(''),
  source = ref(''),
  passwordConfigured = ref(false),
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
  const { source: origin, passwordConfigured: configured, ...input } = value;
  form.value = { ...input, password: '' };
  saved.value = JSON.stringify(form.value);
  passwordConfigured.value = configured;
  source.value = origin === 'DATABASE' ? '管理中心配置' : '部署环境配置';
  probeResult.value = '';
  testResult.value = '';
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
        testResult.value = `测试邮件发送成功，请在 ${result.to} 检查收件箱或垃圾邮件。`;
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
      <div class="form-grid">
        <el-form-item label="服务器地址" for="mail-host">
          <el-input
            id="mail-host"
            v-model="form.host"
            placeholder="例如 smtp.example.org，不含协议和路径"
          />
        </el-form-item>
        <el-form-item label="端口" for="mail-port">
          <el-input-number
            id="mail-port"
            v-model="form.port"
            :min="1"
            :max="65535"
            :controls="false"
          />
        </el-form-item>
        <el-form-item label="连接加密" for="mail-security">
          <el-select id="mail-security" v-model="form.security">
            <el-option value="TLS" label="加密连接（通常使用 465 端口）" />
            <el-option value="STARTTLS" label="连接后升级加密（通常使用 587 端口）" />
            <el-option value="NONE" label="不加密（仅用于本地邮件测试）" />
          </el-select>
        </el-form-item>
        <el-form-item label="服务器认证" for="mail-auth">
          <el-switch id="mail-auth" v-model="form.authEnabled" active-text="使用用户名和密码" />
        </el-form-item>
        <template v-if="form.authEnabled">
          <el-form-item label="认证用户名" for="mail-username">
            <el-input id="mail-username" v-model="form.username" autocomplete="off" />
          </el-form-item>
          <el-form-item label="密码 / 邮箱授权码" for="mail-password">
            <el-input
              id="mail-password"
              v-model="form.password"
              type="password"
              autocomplete="new-password"
              :placeholder="
                passwordConfigured ? '已配置，留空保留原密码' : '填写服务商提供的密码或授权码'
              "
            />
          </el-form-item>
        </template>
        <el-form-item label="发件邮箱" for="mail-from-address">
          <el-input
            id="mail-from-address"
            v-model="form.fromAddress"
            placeholder="noreply@example.org"
          />
        </el-form-item>
        <el-form-item label="发件人名称" for="mail-from-name">
          <el-input
            id="mail-from-name"
            v-model="form.fromName"
            placeholder="南晓开放原子社在线报名系统"
          />
        </el-form-item>
      </div>
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
