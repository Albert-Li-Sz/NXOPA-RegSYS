<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  hydroExportFields,
  requiredHydroExportFields,
  hydroMappableFields,
  hydroBuiltinSourceKeys,
  hydroBuiltinSourceLabels,
  type HydroExportField,
  type HydroFieldMappings,
  type HydroFieldSource,
  type HydroMappingField,
  type HydroMappableField,
} from '@contest-center/contracts';
import { ElMessage } from 'element-plus';
import { api, downloadArchive } from '../api';
import { canManage } from '../permissions';
import type { ContestView } from '../types';
const props = defineProps<{ contests: ContestView[]; initialContestId?: string }>();
const contestId = ref(props.initialContestId ?? '');
const available = computed(() =>
  props.contests.filter((c) => c.modules.integrations && canManage(c.id, 'INTEGRATIONS')),
);
const platform = ref('HYDRO'),
  includeUnofficial = ref(true),
  importMode = ref('FOLLOW');
const officialGroupId = ref(''),
  unofficialGroupId = ref(''),
  busy = ref(false);
const selectedFields = ref<HydroExportField[]>([...hydroExportFields]);
const sources = ref<Partial<Record<HydroMappableField, string>>>({});
const mappingFields = ref<HydroMappingField[]>([]);
const mappingLoading = ref(false),
  mappingError = ref('');
const scopeLabels = {
  PERSON: '成员资料',
  TEAM: '队伍资料',
  REGISTRATION: '报名资料',
  COACH: '教练资料',
};
const defaultSources: Partial<Record<HydroExportField, string>> = {
  id: '固定：报名 UUID',
  name: '固定：本人／队长学号',
  displayName: '系统默认：队名，个人赛为本人姓名',
  password: '固定：与准考证共用的比赛密码',
  school: '系统默认：代表学校／单位',
  members: '系统默认：全部有效成员姓名',
  coach: '系统默认：关联教练姓名',
  seat: '系统默认：考场编号＋座位序号',
  rank: '固定：按参赛性质导出策略',
};
const isMappable = (field: HydroExportField): field is HydroMappableField =>
  (hydroMappableFields as readonly string[]).includes(field);
function restoreDefaults() {
  selectedFields.value = [...hydroExportFields];
  sources.value = {};
}
async function loadFields() {
  const id = contestId.value;
  if (!id) return;
  mappingLoading.value = true;
  mappingError.value = '';
  try {
    const fields = await api<HydroMappingField[]>(`/contests/${id}/platform-exports/fields`);
    if (id === contestId.value) mappingFields.value = fields;
  } catch {
    if (id === contestId.value) mappingError.value = '报名字段加载失败，请重试；默认导出仍可使用。';
  } finally {
    if (id === contestId.value) mappingLoading.value = false;
  }
}
watch(
  contestId,
  () => {
    restoreDefaults();
    mappingFields.value = [];
    mappingError.value = '';
    mappingLoading.value = false;
    void loadFields();
  },
  { immediate: true },
);
function mappings(): HydroFieldMappings {
  return Object.fromEntries(
    hydroMappableFields
      .filter(
        (field) =>
          selectedFields.value.includes(field) &&
          sources.value[field] &&
          sources.value[field] !== 'DEFAULT',
      )
      .map((field) => {
        const [type, key, fieldKey] = sources.value[field]!.split(':');
        const source: HydroFieldSource =
          type === 'BUILTIN'
            ? { type, key: key as (typeof hydroBuiltinSourceKeys)[number] }
            : { type: 'FORM_FIELD', scope: key as HydroMappingField['scope'], key: fieldKey! };
        return [field, source];
      }),
  );
}
const fieldLabels: Record<HydroExportField, string> = {
  id: '报名 ID',
  name: '登录学号',
  displayName: '队名／姓名',
  password: '比赛密码',
  school: '代表单位',
  members: '队员',
  coach: '教练',
  seat: '座位',
  rank: '排名性质',
};
async function download(custom = false) {
  if (!contestId.value || busy.value) return;
  busy.value = true;
  try {
    await downloadArchive(
      `/contests/${contestId.value}/platform-exports`,
      {
        platform: platform.value,
        ...(custom && platform.value === 'HYDRO'
          ? {
              hydroFields: selectedFields.value,
              hydroFieldMappings: mappings(),
            }
          : {}),
        includeUnofficial: includeUnofficial.value,
        importMode: importMode.value,
        ...(platform.value === 'DOMJUDGE'
          ? {
              officialGroupId: officialGroupId.value.trim() || undefined,
              unofficialGroupId: unofficialGroupId.value.trim() || undefined,
            }
          : {}),
      },
      `${platform.value.toLowerCase()}-${contestId.value}.zip`,
    );
    ElMessage.success('平台导入包已导出，请按包内教程在目标平台导入');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="card platform-exports">
    <h3>导出平台导入文件</h3>
    <p class="subtitle">将取得参赛资格的报名导出为 Hydro 或 DOMjudge 导入包。</p>
    <el-form label-position="top" @submit.prevent="download(false)">
      <el-form-item v-if="!initialContestId" label="本站活动／竞赛" for="export-contest">
        <el-select
          id="export-contest"
          v-model="contestId"
          placeholder="选择已启用平台文件导出的活动"
          filterable
          :disabled="busy"
        >
          <el-option v-for="c in available" :key="c.id" :value="c.id" :label="c.title" />
        </el-select>
      </el-form-item>
      <el-form-item label="目标平台">
        <el-radio-group v-model="platform" :disabled="busy">
          <el-radio value="HYDRO">Hydro 最新版（Onsite Toolkit）</el-radio>
          <el-radio value="DOMJUDGE">DOMjudge 9.x</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="参赛性质导出策略">
        <el-radio-group v-model="importMode" :disabled="busy">
          <el-radio value="FOLLOW">跟随报名性质</el-radio>
          <el-radio value="FORCE_UNOFFICIAL">全部作为非正式参赛</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="报名范围">
        <el-switch v-model="includeUnofficial" active-text="包含非正式报名" :disabled="busy" />
      </el-form-item>
      <div v-if="platform === 'DOMJUDGE'" class="form-grid">
        <el-form-item label="正式分组外部 ID（可选）" for="export-official-group">
          <el-input
            id="export-official-group"
            v-model="officialGroupId"
            placeholder="留空自动生成活动专属分组"
            :disabled="busy"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="非正式分组外部 ID（可选）" for="export-unofficial-group">
          <el-input
            id="export-unofficial-group"
            v-model="unofficialGroupId"
            placeholder="应与正式组不同"
            :disabled="busy"
            maxlength="64"
          />
        </el-form-item>
      </div>
      <fieldset v-if="platform === 'HYDRO'" class="export-mappings" :disabled="busy">
        <legend>Hydro 字段与报名资料关联</legend>
        <p class="form-help">
          勾选需要输出的字段，并为其选择报名资料来源；取消勾选则不输出该字段。关联只对本次导出生效。
        </p>
        <el-checkbox-group
          v-model="selectedFields"
          class="mapping-rows"
          :disabled="busy"
          aria-label="输出的 Hydro 字段"
        >
          <div v-for="field in hydroExportFields" :key="field" class="mapping-row">
            <el-checkbox
              :value="field"
              :disabled="requiredHydroExportFields.includes(field) || busy"
            >
              {{ fieldLabels[field] }}（{{ field }}）{{
                requiredHydroExportFields.includes(field) ? ' · 必选' : ''
              }}
            </el-checkbox>
            <el-select
              v-if="isMappable(field)"
              :id="`hydro-source-${field}`"
              :model-value="sources[field] || 'DEFAULT'"
              @update:model-value="sources[field] = $event"
              :aria-label="`${fieldLabels[field]}（${field}）的报名资料来源`"
              :disabled="busy || !selectedFields.includes(field)"
              :loading="mappingLoading"
              filterable
            >
              <el-option value="DEFAULT" :label="defaultSources[field]" />
              <el-option-group label="基础报名资料">
                <el-option
                  v-for="key in hydroBuiltinSourceKeys"
                  :key="key"
                  :value="`BUILTIN:${key}`"
                  :label="hydroBuiltinSourceLabels[key]"
                />
              </el-option-group>
              <el-option-group
                v-for="(scopeLabel, scope) in scopeLabels"
                :key="scope"
                :label="scopeLabel"
              >
                <el-option
                  v-for="f in mappingFields.filter((f) => f.scope === scope)"
                  :key="f.key"
                  :value="`FORM_FIELD:${f.scope}:${f.key}`"
                  :label="`${scopeLabel} · ${f.label}（${f.key}）${f.historical ? ' · 历史字段' : ''}`"
                />
              </el-option-group>
            </el-select>
            <span v-else class="fixed-source">{{ defaultSources[field] }}</span>
          </div>
        </el-checkbox-group>
        <div v-if="mappingError" class="mapping-error" role="alert">
          {{ mappingError }}
          <el-button text :disabled="mappingLoading || busy" @click="loadFields"
            >重新加载字段</el-button
          >
        </div>
        <el-button text :disabled="busy" @click="restoreDefaults">恢复默认</el-button>
        <p class="form-help">
          单值字段关联成员资料时取本人／队长；members
          逐一读取全部有效成员，缺值的成员回退姓名。多选值保留为数组，写入单值字段时以“、”连接；单个文本作为一名成员，不按逗号拆分。教练资料读取全部关联教练，附件、照片不参与关联。
        </p>
        <p class="form-help">
          关联值为空时自动回退该项系统默认来源，包内说明列出各项回退数量。默认导出始终使用系统原有规则，不应用本次关联。
        </p>
        <p class="form-help">
          默认导出包含全部字段；按关联导出仅包含勾选内容。取消比赛密码时整个 ZIP
          均不包含密码。省略密码后新建的 Hydro 账号可能与准考证密码不同；省略队员可能清空远端成员。
        </p>
      </fieldset>
      <p class="notice" v-if="platform === 'HYDRO'">
        包含 teams.json、账号密码表和导入说明。使用官方 Onsite Toolkit 的 onsiteImport
        命令，个人本人／团队队长的学号作为登录名。默认将队名／姓名写入
        displayName，座位使用考场编号加序号（如
        A01），未排座或未填编号时为空；按关联导出时使用上方选择的资料来源。
      </p>
      <p class="notice" v-else>
        包含
        groups.json、organizations.json、teams.json、accounts.json、账号密码表和说明。个人本人／团队队长的学号作为登录名，队伍与账号以报名
        ID 关联。按分组、学校、队伍、用户顺序在 Import / export 中导入。
      </p>
      <p>
        两个平台和准考证共用同一组学号与比赛密码；重复导出和重新生成准考证保持密码不变，与本站登录密码独立。<span
          v-if="platform === 'HYDRO'"
          >导出 password 时，重新导入 Hydro 会重设远端密码。</span
        >含密码的导入文件请妥善保管。完成导出后仍需在目标平台导入，并核对比赛访问权限。
      </p>
      <p v-if="platform === 'HYDRO'">
        每次比赛清空 Hydro 后导入；本包不兼容旧账号或跨活动账号复用。队员只通过 members
        数组导入，正式／非正式性质使用布尔值 rank。
      </p>
      <p>资格撤销或报名删除后，请在目标平台手动处理原账号；新的导入包不会删除远端记录。</p>
      <div class="actions">
        <el-button type="primary" native-type="submit" :loading="busy" :disabled="!contestId">{{
          platform === 'HYDRO' ? '默认导出' : '导出平台导入包'
        }}</el-button>
        <el-button
          v-if="platform === 'HYDRO'"
          :loading="busy"
          :disabled="!contestId"
          @click="download(true)"
          >按关联导出</el-button
        >
        <a href="https://albert-li-sz.github.io/NXOPA-RegSYS/#hydro" target="_blank" rel="noopener"
          >查看导入教程</a
        >
      </div>
    </el-form>
  </div>
</template>
<style scoped>
.platform-exports {
  max-width: 1000px;
}
.export-mappings {
  min-width: 0;
  margin: 0 0 20px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
.export-mappings legend {
  padding: 0 4px;
}
.mapping-row {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) minmax(0, 1.4fr);
  align-items: center;
  gap: 8px 16px;
  padding: 8px 0;
}
.mapping-rows {
  font-size: 14px;
  line-height: 1.5;
}
.mapping-row .el-checkbox {
  margin-right: 0;
  white-space: normal;
  height: auto;
  min-height: 32px;
}
.fixed-source {
  color: var(--el-text-color-secondary);
}
.mapping-error {
  color: var(--el-color-danger);
}
@media (max-width: 600px) {
  .mapping-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
.actions > .el-button {
  min-width: 136px;
}
.el-select {
  width: 100%;
}
p {
  line-height: 1.8;
}
</style>
