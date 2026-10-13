<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import type { Data } from '../types';
const settings = ref<Data>(),
  busy = ref(false),
  error = ref('');
onMounted(async () => {
  try {
    settings.value = await api('/admin/github');
  } catch (e) {
    error.value = String(e);
  }
});
async function save() {
  busy.value = true;
  try {
    settings.value = await api('/admin/github', 'PUT', settings.value);
    ElMessage.success('GitHub 登录设置已保存');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-alert v-if="error" :title="error" type="error" />
  <div v-if="settings" class="card" style="max-width: 800px">
    <h3>GitHub 登录</h3>
    <p class="subtitle">
      在 GitHub 创建 OAuth App，填写 Client ID 和 Client
      Secret，并使用下方回调地址。启用后登录页显示 GitHub 入口。
    </p>
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="启用 GitHub 登录"><el-switch v-model="settings.enabled" /></el-form-item>
      <el-form-item label="Client ID" for="github-client-id"
        ><el-input id="github-client-id" v-model="settings.clientId"
      /></el-form-item>
      <el-form-item label="Client Secret" for="github-client-secret"
        ><el-input
          id="github-client-secret"
          v-model="settings.clientSecret"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="
            settings.secretConfigured ? '已配置；留空保留原密钥' : '请输入 Client Secret'
          "
      /></el-form-item>
      <el-form-item label="回调地址" for="github-callback"
        ><el-input
          id="github-callback"
          v-model="settings.callbackUrl"
          :placeholder="settings.effectiveCallbackUrl"
        /><span class="form-help"
          >留空自动使用当前访问域名；GitHub OAuth App 的 Authorization callback URL
          需与它一致。</span
        ></el-form-item
      >
      <p>
        当前回调地址：<code>{{ settings.callbackUrl || settings.effectiveCallbackUrl }}</code>
      </p>
      <el-button type="primary" native-type="submit" :loading="busy">保存 GitHub 设置</el-button>
    </el-form>
  </div>
</template>
