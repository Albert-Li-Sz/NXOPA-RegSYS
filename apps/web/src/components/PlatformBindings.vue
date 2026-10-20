<script setup lang="ts">
import PaginatedTable from './PaginatedTable.vue';
import { computed, ref, onMounted } from 'vue';
import SchoolMappings from './SchoolMappings.vue';
import { ElMessage } from 'element-plus';
import { useEditSession } from '../composables/useEditSession';
import { api, auth } from '../api';
import type { ContestView, Data } from '../types';
const props = defineProps<{
  contests: ContestView[];
  instances: Data[];
  initialContestId?: string;
}>();
const emit = defineEmits<{ saved: [contest: Data] }>();
const schoolBinding = ref('');
const syncingBinding = ref('');
const contestId = ref(props.initialContestId ?? ''),
  bindings = ref<Data[]>([]),
  busy = ref(false),
  loading = ref(false);
const defaults = () => ({
  instanceId: '',
  remoteContestId: '',
  domainId: 'system',
  groupIds: [] as string[],
  organizationId: '',
  importMode: 'FOLLOW',
  includeUnofficial: true,
  nickname: true,
  unofficialGroupId: '',
  automatic: true,
  enabled: true,
});
const binding = ref<Data>(defaults());
const editSession = useEditSession(binding, true),
  loadedContest = ref(contestId.value);
async function editBinding(row: Data) {
  if (!(await editSession.mayLeave())) return;
  binding.value = { ...row, groupIds: [...row.groupIds] };
  editSession.begin();
}
function cancelBinding() {
  binding.value = defaults();
  editSession.begin();
}
async function changeContest() {
  if (!(await editSession.mayLeave())) {
    contestId.value = loadedContest.value;
    return;
  }
  await loadBindings();
}
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
  loadedContest.value = selected;
  editSession.begin();
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
    emit('saved', await api(`/contests/${contestId.value}`));
  } finally {
    busy.value = false;
  }
}
async function probe(id: string) {
  const result = await api(`/integrations/bindings/${id}/probe`, 'POST');
  ElMessage.success(
    `连接正常，平台版本 ${result.version}${result.pluginVersion ? `，插件版本 ${result.pluginVersion}` : ''}`,
  );
}
async function syncExisting(id: string) {
  syncingBinding.value = id;
  try {
    const result = await api<{ requested: number }>(`/integrations/bindings/${id}/sync`, 'POST');
    ElMessage.success(
      result.requested
        ? `已为 ${result.requested} 条符合条件的报名提交同步任务`
        : '暂无已取得参赛资格的报名可同步',
    );
  } finally {
    syncingBinding.value = '';
  }
}
onMounted(() => {
  if (contestId.value) loadBindings();
});
</script>
<template>
  <div class="card platform-bindings">
    <h3>比赛绑定与报名同步</h3>
    <p class="subtitle">
      可先开放报名，后期再绑定 Hydro 或 DOMjudge。启用自动同步后会补同步已有合格报名，也可手动同步。
    </p>
    <el-form v-if="!initialContestId" label-position="top" class="binding-selector">
      <el-form-item label="本站竞赛" for="binding-contest"
        ><el-select
          id="binding-contest"
          v-model="contestId"
          placeholder="选择要配置的竞赛"
          filterable
          @change="changeContest"
          ><el-option v-for="c in contests" :key="c.id" :value="c.id" :label="c.title" /></el-select
      ></el-form-item>
    </el-form>
    <el-empty v-if="!contestId" description="选择竞赛后配置比赛绑定" :image-size="70" />
    <template v-else>
      <PaginatedTable page-key="platformbindings-bindings" :data="bindings" v-loading="loading">
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
        <el-table-column label="操作" min-width="300"
          ><template #default="{ row }"
            ><el-button
              text
              type="primary"
              :loading="syncingBinding === row.id"
              :disabled="!!syncingBinding || !row.enabled || !row.instance.enabled"
              @click="syncExisting(row.id)"
              >同步已有报名</el-button
            ><el-button text type="primary" @click="probe(row.id)">探测连接</el-button
            ><el-button
              v-if="row.instance.type === 'DOMJUDGE'"
              text
              type="primary"
              @click="schoolBinding = row.id"
              >学校映射</el-button
            ><el-button text @click="editBinding(row)">编辑绑定</el-button></template
          ></el-table-column
        >
      </PaginatedTable>
      <div class="actions">
        <strong>{{ binding.id ? '编辑比赛绑定' : '新增比赛绑定' }}</strong
        ><el-button v-if="binding.id" text type="primary" @click="cancelBinding"
          >取消修改</el-button
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
              filterable
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
            ><el-form-item label="历史报名默认组织编号（可选）" for="binding-organization"
              ><el-input id="binding-organization" v-model="binding.organizationId" /></el-form-item
            ><el-form-item label="正式参赛分组编号" for="binding-group"
              ><el-input
                id="binding-group"
                :model-value="binding.groupIds[0] || ''"
                @update:model-value="
                  (value: string) => (binding.groupIds = value ? [value] : [])
                " /></el-form-item
            ><el-form-item label="非正式参赛分组编号" for="binding-unofficial-group"
              ><el-input
                id="binding-unofficial-group"
                v-model="binding.unofficialGroupId"
                placeholder="与正式组不同的分组编号" /></el-form-item
          ></template>
        </div>
        <el-form-item label="参赛性质导入策略"
          ><el-radio-group v-model="binding.importMode"
            ><el-radio value="FOLLOW">跟随报名性质</el-radio
            ><el-radio value="FORCE_UNOFFICIAL">全部作为非正式参赛</el-radio></el-radio-group
          ></el-form-item
        >
        <el-form-item label="非正式报名"
          ><el-switch v-model="binding.includeUnofficial" active-text="同步非正式报名"
        /></el-form-item>
        <el-form-item v-if="platformType === 'HYDRO'" label="昵称"
          ><el-switch v-model="binding.nickname" active-text="队名／姓名写入目标域昵称"
        /></el-form-item>
        <p v-if="platformType === 'DOMJUDGE'" class="form-help">
          学校映射确认后创建学校、队伍与账号。正式和非正式分组应使用不同排名顺序，并在目标比赛中允许参赛。
        </p>
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
          报名资料、审核与缴费符合竞赛要求后同步。保存启用的自动绑定时，会同时补同步已有合格报名；关闭自动同步时，使用“同步已有报名”批量同步，或在报名管理页逐条同步及重试。已有报名和缴费资料继续保留。
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
    <el-dialog
      :model-value="!!schoolBinding"
      @close="schoolBinding = ''"
      title="DOMjudge 学校与分组"
      width="960px"
      destroy-on-close
      ><SchoolMappings v-if="schoolBinding" :binding-id="schoolBinding"
    /></el-dialog>
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
