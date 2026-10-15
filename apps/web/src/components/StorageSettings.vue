<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditSession } from '../composables/useEditSession';
import EditActions from './EditActions.vue';
import { api, label } from '../api';
import type { Data } from '../types';
const form = ref<Data>({ mode: 'LOCAL', version: 0 }),
  busy = ref(false),
  job = ref<Data>(),
  error = ref('');
const edit = useEditSession(form);
let timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  try {
    form.value = {
      name: 'S3 对象存储',
      endpoint: '',
      region: 'us-east-1',
      bucket: '',
      prefix: 'nxopa',
      accessKey: '',
      forcePathStyle: true,
      createBucket: false,
      ...(await api('/admin/storage')),
      secretKey: '',
    };
    error.value = form.value.configurationError || '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '存储配置加载失败';
  }
}
async function save() {
  busy.value = true;
  try {
    await api('/admin/storage', 'PUT', form.value);
    await load();
    edit.finish();
    ElMessage.success('存储配置已保存');
  } finally {
    busy.value = false;
  }
}
async function probe() {
  busy.value = true;
  try {
    const result = await api('/admin/storage/test', 'POST');
    ElMessage.success(result.message);
  } finally {
    busy.value = false;
  }
}
async function poll() {
  if (!job.value) return;
  const next = await api<Data>(`/jobs/${job.value.id}`);
  job.value = next;
  if (['OUTBOX', 'PENDING', 'RUNNING'].includes(next.state))
    timer = setTimeout(() => void poll(), 3000);
}
async function migrate() {
  await ElMessageBox.confirm(
    '将历史文件复制到当前 S3 存储并更新引用。迁移期间旧文件仍可读取。',
    '迁移文件',
    { type: 'info' },
  );
  job.value = await api('/admin/storage/migrate', 'POST');
  await poll();
}
onMounted(load);
onScopeDispose(() => clearTimeout(timer));
</script>
<template>
  <div class="card">
    <h3>文件存储</h3>
    <p class="form-help">
      内置 MinIO 和第三方 S3 均使用私有桶。系统负责校验访问权限，公开竞赛材料通过系统生成链接。
    </p>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" />
    <EditActions :session="edit" />
    <el-form
      :key="String(edit.editing.value)"
      label-position="top"
      :disabled="!edit.editing.value"
      :class="{ 'read-mode': !edit.editing.value }"
      @submit.prevent="save"
      ><el-form-item label="存储方式"
        ><el-radio-group v-model="form.mode"
          ><el-radio-button value="S3">S3 / MinIO</el-radio-button
          ><el-radio-button value="LOCAL">本地存储</el-radio-button></el-radio-group
        ></el-form-item
      >
      <template v-if="form.mode === 'S3'"
        ><div class="form-grid">
          <el-form-item label="配置名称"><el-input v-model="form.name" /></el-form-item
          ><el-form-item label="S3 端点"
            ><el-input
              v-model="form.endpoint"
              placeholder="https://s3.example.com；AWS S3 可留空" /></el-form-item
          ><el-form-item label="区域"><el-input v-model="form.region" /></el-form-item
          ><el-form-item label="桶名"><el-input v-model="form.bucket" /></el-form-item
          ><el-form-item label="对象前缀"><el-input v-model="form.prefix" /></el-form-item
          ><el-form-item label="访问密钥 ID"
            ><el-input v-model="form.accessKey" autocomplete="off" /></el-form-item
          ><el-form-item label="访问密钥 Secret"
            ><el-input
              v-model="form.secretKey"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="form.secretConfigured ? '留空保留现有密钥' : '请输入密钥'"
          /></el-form-item>
        </div>
        <div class="toolbar">
          <el-switch
            v-model="form.forcePathStyle"
            active-text="Path style（MinIO 通常需要）"
          /><el-switch v-model="form.createBucket" active-text="桶不存在时创建" /></div
      ></template>
      <div class="toolbar">
        <el-button type="primary" v-if="edit.editing.value" native-type="submit" :loading="busy"
          >保存存储配置</el-button
        >
      </div>
    </el-form>
    <el-button :loading="busy" @click="probe">测试当前已保存配置</el-button>
  </div>
  <div class="card">
    <h3>历史文件迁移</h3>
    <p>
      本地附件 {{ form.localAttachments || 0 }} 个，准考证
      {{ form.localAdmissions || 0 }} 个。切换配置后旧文件仍使用原配置读取，可迁移到当前 S3。
    </p>
    <el-button :disabled="form.mode !== 'S3'" @click="migrate">迁移历史文件至当前 S3</el-button>
    <p v-if="job">
      任务 {{ label(job.state) }} · 已复制 {{ job.result?.copied || 0 }} 个对象
      <span v-if="job.error">{{ job.error }}</span>
    </p>
  </div>
</template>
