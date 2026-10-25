<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import type { Data } from '../types';
import { usePagedList } from '../composables/usePagedList';
import ListPagination from './ListPagination.vue';
import { useEditSession } from '../composables/useEditSession';
const list = usePagedList('institutions', () => '/admin/institutions');
const form = ref<Data>({}),
  dialog = ref(false),
  busy = ref(false),
  error = ref('');
const edit = useEditSession(form);
function open(row?: Data) {
  form.value = row
    ? JSON.parse(JSON.stringify(row))
    : {
        name: '',
        shortName: '',
        country: 'CHN',
        province: '',
        city: '',
        aliases: [],
        enabled: true,
      };
  form.value.aliasesText = form.value.aliases.join('\n');
  edit.begin();
  dialog.value = true;
  error.value = '';
}
async function close(done: () => void) {
  if (!busy.value && (await edit.mayLeave())) {
    edit.finish();
    done();
  }
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    form.value.aliases = [
      ...new Set(
        String(form.value.aliasesText)
          .split(/[\n，,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    await api(
      `/admin/institutions${form.value.id ? `/${form.value.id}` : ''}`,
      form.value.id ? 'PUT' : 'POST',
      form.value,
    );
    edit.finish();
    dialog.value = false;
    await list.load();
    ElMessage.success('院校或单位已保存');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    busy.value = false;
  }
}
onMounted(list.load);
</script>
<template>
  <div class="panel">
    <div class="section-heading">
      <h2>院校与单位</h2>
      <el-button type="primary" @click="open()">添加单位</el-button>
    </div>
    <p class="form-help">
      默认包含教育部截至 2026 年 6 月 17 日的 1,412
      所本科院校（不含港澳台）。可添加其他院校、企业或单位。停用不影响已有资料；名称保留，改名请添加新条目。
    </p>
    <div class="toolbar">
      <el-input
        v-model="list.filters.value.search"
        aria-label="搜索院校与单位"
        placeholder="搜索名称、别名或地区"
        clearable
        style="max-width: 360px"
      />
      <el-select
        v-model="list.filters.value.enabled"
        aria-label="目录状态"
        placeholder="全部状态"
        clearable
        style="width: 150px"
        ><el-option label="启用" value="true" /><el-option label="停用" value="false"
      /></el-select>
      <el-button :loading="list.loading.value" @click="list.load">刷新</el-button>
    </div>
    <el-alert v-if="list.error.value" :title="list.error.value" type="error" :closable="false" />
    <el-table :data="list.items.value" v-loading="list.loading.value">
      <el-table-column prop="name" label="名称" min-width="200" /><el-table-column
        prop="shortName"
        label="简称"
        min-width="100"
      />
      <el-table-column prop="province" label="省份／地区" min-width="110" /><el-table-column
        prop="city"
        label="所在地"
        min-width="110"
      />
      <el-table-column label="来源" min-width="100"
        ><template #default="{ row }">{{
          row.source === 'CUSTOM' ? '后台添加' : '教育部名单'
        }}</template></el-table-column
      >
      <el-table-column label="状态" width="90"
        ><template #default="{ row }"
          ><el-tag :type="row.enabled ? 'success' : 'info'">{{
            row.enabled ? '启用' : '停用'
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="操作" width="90"
        ><template #default="{ row }"
          ><el-button text type="primary" @click="open(row)">编辑</el-button></template
        ></el-table-column
      >
    </el-table>
    <ListPagination
      v-model:page="list.page.value"
      v-model:size="list.pageSize.value"
      :total="list.total.value"
      :loading="list.loading.value"
    />
  </div>
  <el-dialog
    v-model="dialog"
    :title="form.id ? '编辑院校或单位' : '添加院校或单位'"
    width="640px"
    :before-close="close"
  >
    <el-form label-position="top" @submit.prevent="save"
      ><div class="form-grid">
        <el-form-item label="院校或单位名称" for="institution-name" required
          ><el-input
            id="institution-name"
            v-model="form.name"
            :disabled="!!form.id || busy"
            maxlength="200"
        /></el-form-item>
        <el-form-item label="简称" for="institution-short"
          ><el-input
            id="institution-short"
            v-model="form.shortName"
            :disabled="busy"
            maxlength="80"
        /></el-form-item>
        <el-form-item label="国家／地区代码" for="institution-country" required
          ><el-input
            id="institution-country"
            v-model="form.country"
            :disabled="busy"
            maxlength="3"
            placeholder="CHN"
        /></el-form-item>
        <el-form-item label="省份／地区" for="institution-province"
          ><el-input
            id="institution-province"
            v-model="form.province"
            :disabled="busy"
            maxlength="80"
        /></el-form-item>
        <el-form-item label="所在地" for="institution-city"
          ><el-input id="institution-city" v-model="form.city" :disabled="busy" maxlength="100"
        /></el-form-item>
        <el-form-item label="启用"
          ><el-switch v-model="form.enabled" :disabled="busy"
        /></el-form-item>
      </div>
      <el-form-item label="搜索别名（每行一个，最多 20 个）" for="institution-aliases"
        ><el-input
          id="institution-aliases"
          v-model="form.aliasesText"
          type="textarea"
          :rows="3"
          :disabled="busy"
      /></el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <div class="actions">
        <el-button @click="close(() => (dialog = false))" :disabled="busy">取消</el-button
        ><el-button type="primary" native-type="submit" :loading="busy">保存</el-button>
      </div></el-form
    >
  </el-dialog>
</template>
<style scoped>
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
</style>
