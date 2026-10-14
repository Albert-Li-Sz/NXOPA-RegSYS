<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import type { Data } from '../types';
const settings = ref<Data>(),
  busy = ref(false);
onMounted(async () => {
  settings.value = await api('/admin/feishu');
});
async function save() {
  busy.value = true;
  try {
    settings.value = await api('/admin/feishu', 'PUT', settings.value);
    ElMessage.success('飞书登录设置已保存');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div v-if="settings" class="card" style="max-width: 860px">
    <h3>飞书登录</h3>
    <p class="form-help">
      在飞书开放平台创建应用，配置 App ID、App Secret 和重定向
      URL，按需开通用户邮箱信息权限。首次使用飞书注册仍需验证本站邮箱。
    </p>
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="启用飞书登录"><el-switch v-model="settings.enabled" /></el-form-item>
      <el-form-item label="App ID" for="feishu-app-id"
        ><el-input id="feishu-app-id" v-model="settings.appId"
      /></el-form-item>
      <el-form-item label="App Secret" for="feishu-app-secret"
        ><el-input
          id="feishu-app-secret"
          v-model="settings.appSecret"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="settings.secretConfigured ? '已配置，留空保留原密钥' : '填写 App Secret'"
      /></el-form-item>
      <el-form-item label="回调地址" for="feishu-callback"
        ><el-input
          id="feishu-callback"
          v-model="settings.callbackUrl"
          :placeholder="settings.effectiveCallbackUrl"
        /><span class="form-help"
          >将下方地址添加至飞书应用的“开发配置 → 安全设置 → 重定向 URL”。</span
        ></el-form-item
      >
      <p class="break-anywhere">
        当前回调地址：<code>{{ settings.callbackUrl || settings.effectiveCallbackUrl }}</code>
      </p>
      <div class="actions">
        <el-button native-type="submit" type="primary" :loading="busy">保存飞书设置</el-button
        ><a
          href="https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code"
          target="_blank"
          rel="noopener noreferrer"
          >飞书官方登录文档</a
        >
      </div>
    </el-form>
  </div>
</template>
