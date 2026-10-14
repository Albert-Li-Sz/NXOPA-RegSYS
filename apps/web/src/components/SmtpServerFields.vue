<script setup lang="ts">
import type { SmtpServerInput } from '@contest-center/contracts';
withDefaults(
  defineProps<{
    server: SmtpServerInput;
    prefix?: string;
    passwordConfigured?: boolean;
  }>(),
  { prefix: 'mail', passwordConfigured: false },
);
</script>
<template>
  <div class="form-grid smtp-fields">
    <el-form-item label="服务器地址" :for="`${prefix}-host`"
      ><el-input :id="`${prefix}-host`" v-model="server.host" placeholder="smtp.example.org"
    /></el-form-item>
    <el-form-item label="端口" :for="`${prefix}-port`"
      ><el-input-number :id="`${prefix}-port`" v-model="server.port" :min="1" :max="65535"
    /></el-form-item>
    <el-form-item label="连接加密" :for="`${prefix}-security`"
      ><el-select :id="`${prefix}-security`" v-model="server.security" filterable
        ><el-option value="TLS" label="加密连接（通常使用 465 端口）" /><el-option
          value="STARTTLS"
          label="连接后升级加密（通常使用 587 端口）" /><el-option
          value="NONE"
          label="不加密（仅用于本地邮件测试）" /></el-select
    ></el-form-item>
    <el-form-item label="服务器认证" :for="`${prefix}-auth`"
      ><el-switch
        :id="`${prefix}-auth`"
        v-model="server.authEnabled"
        active-text="使用用户名和密码"
    /></el-form-item>
    <template v-if="server.authEnabled">
      <el-form-item label="认证用户名" :for="`${prefix}-username`"
        ><el-input :id="`${prefix}-username`" v-model="server.username" autocomplete="off"
      /></el-form-item>
      <el-form-item label="密码 / 邮箱授权码" :for="`${prefix}-password`"
        ><el-input
          :id="`${prefix}-password`"
          v-model="server.password"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="
            passwordConfigured ? '已配置，留空保留原密码' : '填写服务商提供的密码或授权码'
          "
      /></el-form-item>
    </template>
    <el-form-item label="发件邮箱" :for="`${prefix}-from-address`"
      ><el-input
        :id="`${prefix}-from-address`"
        v-model="server.fromAddress"
        placeholder="noreply@example.org"
    /></el-form-item>
    <el-form-item label="发件人名称" :for="`${prefix}-from-name`"
      ><el-input
        :id="`${prefix}-from-name`"
        v-model="server.fromName"
        placeholder="南晓开放原子社在线报名系统"
    /></el-form-item>
  </div>
</template>
<style scoped>
.smtp-fields .el-select,
.smtp-fields .el-input-number {
  width: 100%;
}
</style>
