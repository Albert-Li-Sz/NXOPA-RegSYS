<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, auth } from '../api';
import type { ContestView, Data } from '../types';
const props = defineProps<{ contests: ContestView[]; instances: Data[] }>();
const contestId = ref(''),
  bindings = ref<Data[]>([]),
  busy = ref(false),
  loading = ref(false);
const defaults = () => ({
  instanceId: '',
  remoteContestId: '',
  domainId: 'system',
  groupIds: [] as string[],
  organizationId: '',
  automatic: true,
  enabled: true,
});
const binding = ref<Data>(defaults());
const available = computed(() =>
  props.instances.filter(
    (i) => i.enabled && (auth.user?.isAdmin || i.allowedContestIds.includes(contestId.value)),
  ),
);
const platformType = computed(
  () => props.instances.find((i) => i.id === binding.value.instanceId)?.type,
);
async function loadBindings() {
  const selected = contestId.value;
  bindings.value = [];
  binding.value = defaults();
  if (!selected) return;
  loading.value = true;
  try {
    const rows = await api<Data[]>(`/integrations/bindings?contestId=${selected}`);
    if (contestId.value === selected) bindings.value = rows;
  } finally {
    if (contestId.value === selected) loading.value = false;
  }
}
async function save() {
  busy.value = true;
  try {
    await api('/integrations/bindings', 'POST', {
      ...binding.value,
      contestId: contestId.value,
      organizationId: binding.value.organizationId || undefined,
    });
    ElMessage.success('比赛绑定已保存');
    await loadBindings();
  } finally {
    busy.value = false;
  }
}
async function probe(id: string) {
  const result = await api(`/integrations/bindings/${id}/probe`, 'POST');
  ElMessage.success(`连接正常，平台版本 ${result.version}`);
}
</script>
<template>
  <div class="card platform-bindings">
    <h3>比赛绑定与报名同步</h3>
    <p class="subtitle">选择本站竞赛，将报名关联至 Hydro 或 DOMjudge 的目标比赛。</p>
    <el-form label-position="top" class="binding-selector">
      <el-form-item label="本站竞赛" for="binding-contest"
        ><el-select
          id="binding-contest"
          v-model="contestId"
          placeholder="选择要配置的竞赛"
          filterable
          @change="loadBindings"
          ><el-option v-for="c in contests" :key="c.id" :value="c.id" :label="c.title" /></el-select
      ></el-form-item>
    </el-form>
    <el-empty v-if="!contestId" description="选择竞赛后配置比赛绑定" :image-size="70" />
    <template v-else>
      <el-table :data="bindings" v-loading="loading">
        <el-table-column label="平台" min-width="180"
          ><template #default="{ row }"
            >{{ row.instance.name }} ·
            {{ row.instance.type === 'HYDRO' ? 'Hydro' : 'DOMjudge' }}</template
          ></el-table-column
        >
        <el-table-column label="目标比赛编号" prop="remoteContestId" min-width="180" />
        <el-table-column label="同步方式" min-width="120"
          ><template #default="{ row }">{{
            row.automatic ? '资格生效时自动同步' : '管理员手动同步'
          }}</template></el-table-column
        >
        <el-table-column label="状态" width="75"
          ><template #default="{ row }">{{
            row.enabled ? '启用' : '停用'
          }}</template></el-table-column
        >
        <el-table-column label="操作" min-width="175"
          ><template #default="{ row }"
            ><el-button text type="primary" @click="probe(row.id)">探测连接</el-button
            ><el-button text @click="binding = { ...row, groupIds: [...row.groupIds] }"
              >编辑绑定</el-button
            ></template
          ></el-table-column
        >
      </el-table>
      <div class="actions">
        <strong>{{ binding.id ? '编辑比赛绑定' : '新增比赛绑定' }}</strong
        ><el-button v-if="binding.id" text type="primary" @click="binding = defaults()"
          >新增绑定</el-button
        >
      </div>
      <el-form label-position="top" @submit.prevent="save">
        <div class="form-grid">
          <el-form-item label="评测实例" for="binding-instance"
            ><el-select
              id="binding-instance"
              v-model="binding.instanceId"
              :disabled="!!binding.id"
              placeholder="选择 Hydro 或 DOMjudge 实例"
              ><el-option
                v-for="i in available"
                :key="i.id"
                :value="i.id"
                :label="`${i.name} · ${i.type === 'HYDRO' ? 'Hydro' : 'DOMjudge'}`" /></el-select
          ></el-form-item>
          <el-form-item label="目标比赛编号" for="binding-remote"
            ><el-input
              id="binding-remote"
              v-model="binding.remoteContestId"
              :disabled="!!binding.id"
              placeholder="填写评测平台中的比赛编号"
          /></el-form-item>
          <el-form-item v-if="platformType === 'HYDRO'" label="平台域编号" for="binding-domain"
            ><el-input id="binding-domain" v-model="binding.domainId" placeholder="system"
          /></el-form-item>
          <template v-if="platformType === 'DOMJUDGE'"
            ><el-form-item label="组织编号（可选）" for="binding-organization"
              ><el-input id="binding-organization" v-model="binding.organizationId" /></el-form-item
            ><el-form-item label="分组编号（可选）" for="binding-group"
              ><el-input
                id="binding-group"
                :model-value="binding.groupIds[0] || ''"
                @update:model-value="
                  (value: string) => (binding.groupIds = value ? [value] : [])
                " /></el-form-item
          ></template>
        </div>
        <el-form-item label="报名同步"
          ><el-switch
            v-model="binding.automatic"
            aria-label="参赛资格生效时自动同步"
            active-text="参赛资格生效时自动同步"
        /></el-form-item>
        <el-form-item label="绑定状态"
          ><el-switch
            v-model="binding.enabled"
            aria-label="启用比赛绑定"
            active-text="启用比赛绑定"
        /></el-form-item>
        <p class="form-help">
          报名资料、审核与缴费符合竞赛要求后同步。关闭自动同步时，可在报名管理页手动同步及重试。
        </p>
        <el-button
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="!binding.instanceId || !binding.remoteContestId.trim()"
          >保存比赛绑定</el-button
        >
      </el-form>
    </template>
  </div>
</template>
<style scoped>
.binding-selector {
  margin-top: 22px;
  max-width: 600px;
}
.el-select {
  width: 100%;
}
.form-help {
  margin: 0 0 20px;
  line-height: 1.8;
}
</style>
