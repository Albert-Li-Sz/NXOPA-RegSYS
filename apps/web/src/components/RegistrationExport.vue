<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { handleAuthResponse } from '../api';
const props = defineProps<{ contestId: string; filters: string; accountsEnabled: boolean }>();
const open = ref(false),
  busy = ref(false),
  format = ref('xlsx'),
  includeCredentials = ref(false);
async function download() {
  busy.value = true;
  try {
    const query = new URLSearchParams(props.filters);
    query.set('contestId', props.contestId);
    query.set('format', format.value);
    query.set('includeCredentials', String(props.accountsEnabled && includeCredentials.value));
    const response = await fetch(`/api/v1/registrations/export?${query}`, {
      signal: AbortSignal.timeout(180000),
    });
    handleAuthResponse('/registrations/export', response.status);
    if (!response.ok) throw new Error((await response.json()).message || '导出失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `registrations.${format.value}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    open.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导出失败，请重试');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-button
    @click="
      open = true;
      includeCredentials = false;
    "
    >导出名单</el-button
  >
  <el-dialog
    v-model="open"
    title="导出报名信息"
    width="min(520px, 94vw)"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <p>导出当前筛选条件下的全部报名，每名选手一行。</p>
    <el-form label-position="top" :disabled="busy">
      <el-form-item label="文件格式"
        ><el-radio-group v-model="format"
          ><el-radio value="xlsx">Excel（.xlsx）</el-radio
          ><el-radio value="csv">CSV</el-radio></el-radio-group
        ></el-form-item
      >
      <el-checkbox v-if="accountsEnabled" v-model="includeCredentials"
        >包含比赛账号密码</el-checkbox
      >
    </el-form>
    <template #footer
      ><el-button :disabled="busy" @click="open = false">取消</el-button
      ><el-button type="primary" :loading="busy" @click="download">下载</el-button></template
    >
  </el-dialog>
</template>
