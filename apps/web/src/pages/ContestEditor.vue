<script setup lang="ts">
import PaginatedTable from '../components/PaginatedTable.vue';
import DeleteContestButton from '../components/DeleteContestButton.vue';
import PaginatedList from '../components/PaginatedList.vue';
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type TableInstance } from 'element-plus';
import {
  policySchema,
  defaultFields,
  defaultTemplate,
  platformTemplates,
  mergePlatformFields,
  registrationReviewPhase,
  fieldSchema,
} from '@contest-center/contracts';
import { api, auth, date, label, money, downloadArchive, handleAuthResponse } from '../api';
import type { Data, FieldDefinition } from '../types';
import EditActions from '../components/EditActions.vue';
import RegistrationReview from '../components/RegistrationReview.vue';
import RemoteRevocations from '../components/RemoteRevocations.vue';
import SeatingManager from '../components/SeatingManager.vue';
import ExamSiteConfig from '../components/ExamSiteConfig.vue';
import FinanceList from '../components/FinanceList.vue';
import { useEditSession, mayLeaveEdits, confirmLeaveEdits } from '../composables/useEditSession';
import MarkdownEditor from '../components/MarkdownEditor.vue';
import PlatformExports from '../components/PlatformExports.vue';
import FileLibrary from '../components/FileLibrary.vue';
import { canManage } from '../permissions';
import ListPagination from '../components/ListPagination.vue';
import { usePagedList } from '../composables/usePagedList';
const roster = usePagedList('contest-registrations', () =>
  isNew.value ? '' : `/registrations?contestId=${route.params.id}`,
);
const route = useRoute(),
  router = useRouter(),
  isNew = computed(() => route.params.id === 'new'),
  tab = ref(String(route.query.tab ?? 'settings')),
  busy = ref(false),
  loading = ref(true),
  loadError = ref(''),
  moduleError = ref(''),
  rows = roster.items,
  templates = ref<Data[]>([]),
  registry = ref<Data[]>([]),
  preview = ref<Data>();
const form = ref<Data>({
  kind: 'COMPETITION',
  modules: { admissions: true, rooms: false, integrations: true },
  seatingMode: 'REGISTRATION',
  title: '',
  season: '2026',
  description: '',
  descriptionFormat: 'MARKDOWN',
  announcement: '',
  location: '',
  examSites: [],
  startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  opensAt: new Date().toISOString(),
  closesAt: new Date(Date.now() + 6 * 86400000).toISOString(),
  correctionUntil: null,
  publicRosterEnabled: false,
  publicRosterReviews: ['APPROVED'],
  published: false,
  archived: false,
  manuallyClosed: false,
  policy: policySchema.parse({}),
  fields: JSON.parse(JSON.stringify(defaultFields)),
});
const savedTitle = ref('');
const template = ref({ name: '活动准考证模板', source: defaultTemplate, version: 0 });
const feeYuan = computed({
  get: () => form.value.policy.feeCents / 100,
  set: (value: number | undefined) => {
    form.value.policy.feeCents = Math.round(Number(value ?? 0) * 100);
  },
});
const savedModules = ref(JSON.stringify(form.value.modules));
const edit = useEditSession(form, isNew.value),
  templateEdit = useEditSession(template);
const revocations = ref<Data[]>([]);
const reviewOpen = ref(false),
  reviewId = ref(''),
  reviewQueue = ref<string[]>([]);
async function openReview(row: Data) {
  if (registrationReviewPhase(row as { status: string; review: string }) === 'AMEND') {
    reviewQueue.value = [];
    reviewId.value = row.id;
    reviewOpen.value = true;
    return;
  }
  const queue = await api(
    `/registrations/review-queue?contestId=${route.params.id}&${roster.query(false)}`,
  );
  const ids = queue.ids as string[],
    index = ids.indexOf(row.id);
  reviewQueue.value = [...ids.slice(index + 1), ...ids.slice(0, Math.max(0, index))].filter(
    (id) => id !== row.id,
  );
  reviewId.value = row.id;
  reviewOpen.value = true;
}
async function nextReview() {
  try {
    while (reviewQueue.value.length) {
      const id = reviewQueue.value.shift()!;
      const response = await fetch(`/api/v1/registrations/${id}?history=false`, {
        credentials: 'same-origin',
      });
      handleAuthResponse('/registrations', response.status);
      if (response.status === 404) continue;
      if (!response.ok) throw new Error('报名状态或管理权限已变化');
      const value = await response.json();
      if (!value.actions.review) continue;
      reviewId.value = id;
      return;
    }
    reviewOpen.value = false;
    ElMessage.success('当前筛选范围内的报名已处理完成');
  } catch {
    reviewOpen.value = false;
    reviewQueue.value = [];
    moduleError.value = '本条审核已保存，但下一条报名加载失败；请刷新报名列表后继续审核。';
  }
}
async function removeRegistration(row: Data) {
  const { value } = await ElMessageBox.prompt(
    '报名资料及准考证将永久删除；财务单据独立保留。请填写删除原因。',
    '删除报名',
    {
      inputType: 'textarea',
      inputValidator: (value: string) => !!value.trim() || '请填写删除原因',
      confirmButtonText: '永久删除',
      type: 'warning',
    },
  );
  await api(`/registrations/${row.id}`, 'DELETE', { version: row.version, reason: value });
  await refreshModules();
}
async function applyPreset() {
  await ElMessageBox.confirm(
    '应用预设将重置当前草稿中的费用、老师、功能开关和报名形式；报名字段保留。保存后生效。',
    '应用配置预设',
  );
  const activity = form.value.kind === 'ACTIVITY';
  form.value.policy = policySchema.parse({ coachMode: activity ? 'DISABLED' : 'OPTIONAL' });
  form.value.modules = { admissions: !activity, rooms: false, integrations: !activity };
  form.value.seatingMode = 'REGISTRATION';
}
function newKind() {
  if (isNew.value) {
    const activity = form.value.kind === 'ACTIVITY';
    form.value.policy = policySchema.parse({ coachMode: activity ? 'DISABLED' : 'OPTIONAL' });
    form.value.modules = { admissions: !activity, rooms: false, integrations: !activity };
  }
}
const selected = ref<Data[]>([]),
  batchBusy = ref(false),
  statusFilter = ref(''),
  search = ref(''),
  fieldDialog = ref(false),
  editingField = ref(-1),
  field = ref<Data>({}),
  options = ref('');
const permission = (item: Parameters<typeof canManage>[1]) =>
  isNew.value ? !!auth.user?.isAdmin : canManage(String(route.params.id), item);
const availableTabs = computed(() =>
  [
    { name: 'settings', label: '活动设置', show: permission('CONTEST') },
    { name: 'fields', label: '报名字段', show: permission('CONTEST') },
    { name: 'registrations', label: '报名管理', show: !isNew.value && permission('REGISTRATIONS') },
    {
      name: 'templates',
      label: '准考证模板',
      show: !isNew.value && permission('ADMISSIONS') && form.value.modules.admissions,
    },
    {
      name: 'integrations',
      label: '平台文件导出',
      show: !isNew.value && permission('INTEGRATIONS') && form.value.modules.integrations,
    },
    { name: 'files', label: '活动附件', show: !isNew.value && permission('FILES') },
    {
      name: 'rooms',
      label: '考场与座位',
      show: !isNew.value && permission('ADMISSIONS') && form.value.modules.rooms,
    },
    { name: 'finance', label: '财务记录', show: !isNew.value && permission('FINANCE') },
    {
      name: 'revocations',
      label: '平台撤权待办',
      show: revocations.value.length > 0 && permission('INTEGRATIONS'),
    },
  ].filter((item) => item.show),
);
function normalizeTab() {
  if (!availableTabs.value.some((item) => item.name === tab.value))
    tab.value = availableTabs.value[0]?.name ?? '';
}
const filtered = computed(() => rows.value);
const batchRows = computed(() => (selected.value.length ? selected.value : rows.value));
const batchIds = computed(() => batchRows.value.filter((r) => r.eligible).map((r) => r.id));
const batchBlocked = computed(
  () => batchBusy.value || roster.loading.value || !!roster.error.value || !batchIds.value.length,
);
watch(
  [statusFilter, search],
  ([review, value]) => {
    roster.filters.value = { ...roster.filters.value, review, search: value };
    selected.value = [];
  },
  { flush: 'sync' },
);
const rosterTable = ref<TableInstance>();
watch(
  roster.filters,
  () => {
    selected.value = [];
    rosterTable.value?.clearSelection();
  },
  { deep: true, flush: 'sync' },
);
watch(
  () => form.value.policy.platformProfiles,
  (profiles) => {
    form.value.fields = mergePlatformFields(form.value.fields, profiles ?? []);
  },
  { deep: true },
);
const sum = ref({ total: 0, pending: 0, approved: 0, rejected: 0, eligible: 0 });
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    registry.value = await api('/admin/fields');
    if (!isNew.value) {
      form.value = await api(`/contests/${route.params.id}`);
      savedTitle.value = form.value.title;
      form.value.policy = policySchema.parse(form.value.policy);
      savedModules.value = JSON.stringify(form.value.modules);
      if (permission('INTEGRATIONS'))
        revocations.value = await api(`/integrations/revocations?contestId=${route.params.id}`);
    }
    normalizeTab();
    if (!isNew.value) await refreshModules();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '竞赛配置加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);
async function refreshModules() {
  moduleError.value = '';
  try {
    if (tab.value === 'registrations') {
      await roster.load();
      sum.value = await api(`/contests/${route.params.id}/statistics?${roster.query(false)}`);
    }
    if (
      ['templates', 'registrations'].includes(tab.value) &&
      permission('ADMISSIONS') &&
      form.value.modules.admissions
    ) {
      templates.value = await api(`/admissions/templates?contestId=${route.params.id}`);
      const active =
        templates.value.find((t) => t.contestId === route.params.id && t.active) ??
        templates.value.find((t) => t.active);
      if (active && !templateEdit.editing.value)
        template.value = {
          name: active.name,
          source: active.source,
          version:
            templates.value.find((t) => t.contestId === route.params.id && t.active)?.version ?? 0,
        };
    }
  } catch (e) {
    moduleError.value = e instanceof Error ? e.message : '管理数据加载失败';
  }
}
watch(tab, () => {
  if (!isNew.value && !loading.value) refreshModules();
});
watch(availableTabs, () => {
  if (!loading.value) normalizeTab();
});
let statisticsSequence = 0;
watch(
  roster.filters,
  async () => {
    if (isNew.value) return;
    const sequence = ++statisticsSequence;
    try {
      const value = await api(`/contests/${route.params.id}/statistics?${roster.query(false)}`);
      if (sequence === statisticsSequence) sum.value = value;
    } catch (e) {
      if (sequence === statisticsSequence)
        moduleError.value = e instanceof Error ? e.message : '报名统计加载失败';
    }
  },
  { deep: true },
);
async function importSeats(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const lines = (await file.text())
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
  const seats = lines.slice(1).map((line) => {
    const [registrationId, room, seat, number, location] = line.split(',').map((s) => s.trim());
    return {
      registrationId,
      room,
      seat,
      number: number || undefined,
      location: location || undefined,
    };
  });
  await api('/admissions/generate', 'POST', {
    registrationIds: seats.map((s) => s.registrationId),
    seats,
  });
  ElMessage.success('座位已导入，准考证生成任务已入队');
}
async function save() {
  busy.value = true;
  try {
    const p = form.value.policy;
    if (p.mode === 'INDIVIDUAL') {
      p.minMembers = 1;
      p.maxMembers = 1;
    }
    if (p.coachMode === 'DISABLED') p.maxCoaches = 0;
    const previous = JSON.parse(savedModules.value);
    const disabled = Object.keys(previous).filter(
      (key) => previous[key] && !form.value.modules[key],
    );
    if (!isNew.value && disabled.length)
      await ElMessageBox.confirm(
        '关闭功能会停止相应操作，使相关准考证失效或停止平台文件导出。远端已导入的账号需在目标平台手动处理。确认保存？',
        '确认关闭功能',
        { type: 'warning' },
      );
    const c = await api(
      isNew.value ? '/contests' : `/contests/${route.params.id}`,
      isNew.value ? 'POST' : 'PUT',
      { ...form.value, confirmModuleChanges: disabled.length > 0 },
    );
    ElMessage.success('竞赛配置已保存');
    edit.finish();
    if (isNew.value) router.replace(`/admin/contests/${c.id}`);
    else {
      form.value = await api(`/contests/${c.id}`);
      savedTitle.value = form.value.title;
      savedModules.value = JSON.stringify(form.value.modules);
      if (permission('INTEGRATIONS'))
        revocations.value = await api(`/integrations/revocations?contestId=${route.params.id}`);
    }
  } finally {
    busy.value = false;
  }
}
function editField(index = -1) {
  editingField.value = index;
  field.value =
    index < 0
      ? {
          key: '',
          label: '',
          scope: 'PERSON',
          type: 'text',
          required: false,
          sensitive: false,
          options: [],
          help: '',
          group: '基本信息',
        }
      : JSON.parse(JSON.stringify(form.value.fields[index]));
  options.value = field.value.options.join('\n');
  fieldDialog.value = true;
}
function saveField() {
  const parsed = fieldSchema.safeParse({
    ...field.value,
    options: options.value.split('\n').filter(Boolean),
  });
  if (!parsed.success) {
    ElMessage.error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
    return;
  }
  const f = parsed.data;
  if (
    form.value.fields.some(
      (item: FieldDefinition, index: number) =>
        index !== editingField.value && item.scope === f.scope && item.key === f.key,
    )
  ) {
    ElMessage.error('同一作用域内字段键名不能重复');
    return;
  }
  if (editingField.value < 0) form.value.fields.push(f);
  else form.value.fields[editingField.value] = f;
  fieldDialog.value = false;
}
const conditionSource = computed<FieldDefinition | undefined>(() =>
  form.value.fields.find(
    (f: FieldDefinition) => f.key === field.value.condition?.key && f.scope === field.value.scope,
  ),
);
const conditionFields = computed(() =>
  (form.value.fields as FieldDefinition[]).filter(
    (f) => f.scope === field.value.scope && f.key !== field.value.key,
  ),
);
function changeConditionKey(key: string) {
  const type = conditionSource.value?.type;
  field.value.condition =
    type === 'multiselect'
      ? { key, includes: '' }
      : { key, equals: type === 'boolean' ? false : type === 'number' ? 0 : '' };
}
function importField(key: string) {
  const item = registry.value.find((x) => x.key === key);
  if (item) form.value.fields.push(JSON.parse(JSON.stringify(item.definition)));
}
async function saveTemplate() {
  await api('/admissions/templates', 'POST', { ...template.value, contestId: route.params.id });
  templateEdit.finish();
  ElMessage.success('模板新版本已保存');
  await refreshModules();
}
async function previewTemplate() {
  preview.value = await api('/admissions/preview', 'POST', {
    contestId: route.params.id,
    source: template.value.source,
  });
}
async function checkPreview() {
  preview.value = await api(`/jobs/${preview.value!.id}`);
}
async function generate() {
  if (batchBlocked.value) return;
  const ids = [...batchIds.value],
    query = roster.query();
  batchBusy.value = true;
  try {
    await ElMessageBox.confirm(
      `本次将为${selected.value.length ? '已勾选' : '当前页'}的 ${ids.length} 份有效报名生成准考证。确认继续？`,
      '批量生成准考证',
    );
    let room = '',
      seat = '';
    if (!form.value.modules.rooms) {
      const { value } = await ElMessageBox.prompt(
        '考场 / 座位起始号（连续分配），例如 A101 / 1',
        '生成准考证',
      );
      [room, seat] = value.split('/').map((x) => x.trim());
    }
    requireBatchScope(query);
    await api('/admissions/generate', 'POST', {
      registrationIds: ids,
      location: form.value.location,
      room,
      seat,
      incrementSeats: true,
    });
    ElMessage.success('生成任务已入队');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close')
      moduleError.value = e instanceof Error ? e.message : '准考证生成失败，请重试';
  } finally {
    batchBusy.value = false;
  }
}
function requireBatchScope(query: string) {
  if (roster.loading.value || roster.error.value || query !== roster.query())
    throw new Error('报名列表或筛选范围已变化，请重新加载并核对后操作');
}
async function downloadAdmissions() {
  if (batchBlocked.value) return;
  const registrationIds = [...batchIds.value],
    query = roster.query();
  if (registrationIds.length > 1000) {
    ElMessage.warning('每次最多下载 1000 份，请分批选择');
    return;
  }
  batchBusy.value = true;
  try {
    await ElMessageBox.confirm(
      `下载${selected.value.length ? '已勾选' : '当前页'}的 ${registrationIds.length} 份有效报名准考证。`,
      '确认下载范围',
    );
    requireBatchScope(query);
    await downloadArchive('/admissions/batch', { registrationIds }, 'admissions.zip');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close')
      moduleError.value = e instanceof Error ? e.message : '准考证下载失败，请重试';
  } finally {
    batchBusy.value = false;
  }
}
const availableVariables = computed(() => [
  'contest.title',
  'account.username',
  'account.password',
  'contest.startsAt',
  'admission.number',
  'admission.location',
  'admission.room',
  'admission.seat',
  'team.name',
  'team.englishName',
  'participant.name',
  ...form.value.fields
    .filter((f: FieldDefinition) => f.type === 'photo')
    .map(
      (f: FieldDefinition) =>
        `${f.scope === 'PERSON' ? 'participant' : f.scope === 'TEAM' ? 'team' : f.scope === 'REGISTRATION' ? 'registration' : 'coaches.0'}.assets.${f.key}`,
    ),
  ...form.value.fields.map(
    (f: FieldDefinition) =>
      `${f.scope === 'PERSON' ? 'participant' : f.scope === 'COACH' ? 'this' : f.scope === 'TEAM' ? 'registration.answers.team' : 'registration.answers.registration'}.${f.scope === 'PERSON' || f.scope === 'COACH' ? 'answers.' : ''}${f.key}`,
  ),
]);
function insertVariable(v: string) {
  template.value.source += `{{${v}}}`;
}
</script>
<template>
  <el-result v-if="loadError" icon="warning" title="竞赛配置加载失败" :sub-title="loadError"
    ><template #extra
      ><el-button type="primary" @click="load">重新加载</el-button></template
    ></el-result
  >
  <el-skeleton v-else-if="loading" :rows="8" animated />
  <template v-else>
    <div class="crumb">
      <router-link to="/admin/contests">活动及竞赛管理中心</router-link><span>／</span
      ><span>{{ isNew ? '创建活动及竞赛' : form.title }}</span>
    </div>
    <div class="page-heading" style="margin-top: 24px">
      <div>
        <h1>{{ isNew ? '创建活动及竞赛' : form.title }}</h1>
        <p class="subtitle">配置报名规则，处理审核、准考证和平台文件导出</p>
      </div>
      <div v-if="!isNew" class="button-group">
        <el-button @click="router.push(`/contests/${route.params.id}`)">查看公开页面</el-button>
        <DeleteContestButton
          :contest="{
            id: form.id,
            title: savedTitle,
            version: form.version,
            deletion: form.deletion,
          }"
          :before-remove="confirmLeaveEdits"
          @deleted="router.push('/admin/contests')"
        />
      </div>
    </div>
    <EditActions
      v-if="['settings', 'fields'].includes(tab)"
      :session="edit"
      :allow="permission('CONTEST')"
    />
    <el-tabs v-model="tab" :before-leave="mayLeaveEdits">
      <el-tab-pane
        v-for="item in availableTabs"
        :key="item.name"
        :label="item.label"
        :name="item.name"
      />
    </el-tabs>
    <el-alert v-if="moduleError" :title="moduleError" type="error" :closable="false"
      ><el-button @click="refreshModules">重新加载</el-button></el-alert
    >
    <RemoteRevocations
      v-if="tab === 'revocations' && permission('INTEGRATIONS')"
      :contest-id="String(route.params.id)"
    />
    <SeatingManager
      v-if="tab === 'rooms' && permission('ADMISSIONS')"
      :contest-id="String(route.params.id)"
    />
    <FinanceList
      v-if="tab === 'finance' && permission('FINANCE')"
      :contest-id="String(route.params.id)"
    />
    <RegistrationReview
      v-model="reviewOpen"
      :registration-id="reviewId"
      @reviewed="refreshModules"
      @next="nextReview"
    />
    <FileLibrary
      v-if="tab === 'files' && permission('FILES')"
      :contest-id="String(route.params.id)"
    />
    <div class="panel" v-if="tab === 'settings' && permission('CONTEST')">
      <el-form
        :key="String(edit.editing.value)"
        label-position="top"
        :disabled="!edit.editing.value || busy"
        :class="{ 'read-mode': !edit.editing.value }"
        ><div class="card">
          <h3>基本信息</h3>
          <div class="card">
            <h3>活动类型与功能</h3>
            <el-form-item label="配置类型"
              ><el-select v-model="form.kind" filterable @change="newKind"
                ><el-option value="COMPETITION" label="竞赛" /><el-option
                  value="ACTIVITY"
                  label="通用活动" /></el-select></el-form-item
            ><el-button v-if="edit.editing.value" @click="applyPreset"
              >应用此类型的默认预设</el-button
            >
            <p class="form-help">
              已保存活动切换类型仅改变类型；应用预设需单独确认，已有数据会在保存时检查。
            </p>
            <div class="toolbar">
              <el-checkbox v-model="form.modules.admissions">启用准考证</el-checkbox
              ><el-checkbox v-model="form.modules.rooms">启用考场与座位</el-checkbox
              ><el-checkbox v-model="form.modules.integrations">启用平台文件导出</el-checkbox>
            </div>
            <p class="form-help">
              可先开放报名，后续启用平台文件导出。启用后，Hydro、DOMjudge
              和准考证共用本人／队长学号及同一个随机比赛密码。
            </p>
            <el-form-item v-if="form.modules.rooms" label="排考单位"
              ><el-select v-model="form.seatingMode" filterable
                ><el-option
                  value="REGISTRATION"
                  label="每份报名一座（个人一人／团队一队）" /><el-option
                  value="PERSON"
                  label="每位成员一座，同队同场" /></el-select
            ></el-form-item>
          </div>
          <div class="form-grid">
            <el-form-item label="名称" required for="contest-title"
              ><el-input id="contest-title" v-model="form.title" /></el-form-item
            ><el-form-item label="赛季" for="contest-season"
              ><el-input id="contest-season" v-model="form.season" /></el-form-item
            ><el-form-item label="活动开始时间"
              ><el-date-picker
                v-model="form.startsAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
            ><el-form-item label="活动地点"><el-input v-model="form.location" /></el-form-item
            ><el-form-item label="报名开放时间"
              ><el-date-picker
                v-model="form.opensAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
            ><el-form-item label="报名截止时间"
              ><el-date-picker
                v-model="form.closesAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
            ><el-form-item label="补正截止时间"
              ><el-date-picker
                v-model="form.correctionUntil"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
            ><el-form-item label="发布与关闭"
              ><el-switch v-model="form.published" active-text="公开发布" /><el-switch
                v-model="form.manuallyClosed"
                active-text="关闭报名"
                style="margin-left: 15px"
            /></el-form-item>
          </div>
          <el-form-item label="队伍公示"
            ><el-switch v-model="form.publicRosterEnabled" active-text="开启公示名单"
          /></el-form-item>
          <el-form-item v-if="form.publicRosterEnabled" label="公示的审核状态"
            ><el-checkbox-group v-model="form.publicRosterReviews"
              ><el-checkbox
                v-for="state in ['APPROVED', 'PENDING', 'REJECTED']"
                :key="state"
                :value="state"
                >{{ label(state) }}</el-checkbox
              ></el-checkbox-group
            >
            <p class="form-help">
              公示仅包含队名、学校、队员姓名、指导老师、排名与审核状态。
            </p></el-form-item
          >
          <el-form-item label="活动介绍"
            ><MarkdownEditor
              v-model="form.description"
              v-model:format="form.descriptionFormat" /></el-form-item
          ><el-form-item label="公告"
            ><el-input v-model="form.announcement" type="textarea" :rows="3" /></el-form-item
          ><el-switch v-model="form.archived" active-text="归档竞赛" />
        </div>
        <ExamSiteConfig v-model="form.examSites" :editing="edit.editing.value" />
        <div class="card">
          <h3>报名规则</h3>
          <div class="form-grid">
            <el-form-item label="报名方式"
              ><el-radio-group v-model="form.policy.mode"
                ><el-radio-button value="INDIVIDUAL">个人报名</el-radio-button
                ><el-radio-button value="TEAM">团队报名</el-radio-button></el-radio-group
              ></el-form-item
            ><el-form-item v-if="form.policy.mode === 'TEAM'" label="成员填写方式"
              ><el-radio-group v-model="form.policy.memberMode"
                ><el-radio value="INVITE">邀请确认</el-radio
                ><el-radio value="MANUAL">队长代填</el-radio></el-radio-group
              ></el-form-item
            ><el-form-item v-if="form.policy.mode === 'TEAM'" label="团队人数"
              ><el-input-number v-model="form.policy.minMembers" :min="1" :max="30" /><span
                style="margin: 0 10px"
                >至</span
              ><el-input-number v-model="form.policy.maxMembers" :min="1" :max="30" /></el-form-item
            ><el-form-item label="指导老师"
              ><el-select v-model="form.policy.coachMode" filterable
                ><el-option label="不设置指导老师" value="DISABLED" /><el-option
                  label="可选指导老师"
                  value="OPTIONAL" /><el-option
                  label="必须关联指导老师"
                  value="REQUIRED" /></el-select></el-form-item
            ><el-form-item v-if="form.policy.coachMode !== 'DISABLED'" label="老师人数上限"
              ><el-input-number v-model="form.policy.maxCoaches" :min="1" :max="10" /></el-form-item
            ><el-form-item label="审核"
              ><el-switch
                v-model="form.policy.manualReview"
                active-text="管理员审核"
                inactive-text="自动通过" /></el-form-item
            ><el-form-item label="非正式参赛"
              ><el-switch v-model="form.policy.allowUnofficial" active-text="允许申请非正式参赛" />
              <p class="form-help">非正式申请必须由管理员审核，其他报名规则相同。</p></el-form-item
            >
            <el-form-item label="平台基础字段模板"
              ><el-select
                v-model="form.policy.platformProfiles"
                multiple
                placeholder="选择接入平台"
                filterable
                ><el-option
                  v-for="p in platformTemplates"
                  :key="p.id"
                  :value="p.id"
                  :label="p.name" /></el-select
            ></el-form-item>
            <el-form-item label="报名名额（份）">
              <el-input-number
                v-model="form.policy.capacity"
                :min="0"
                :max="1000000"
                :precision="0"
              />
              <p class="form-help">0 表示不限；个人或团队每份已提交报名占一个名额，取消后释放。</p>
            </el-form-item>
            <el-form-item label="重复参赛检查字段"
              ><el-select
                v-model="form.policy.uniquePersonFields"
                multiple
                placeholder="例如学校与学号组合"
                filterable
                ><el-option
                  v-for="f in form.fields.filter((x: FieldDefinition) => x.scope === 'PERSON')"
                  :key="f.key"
                  :value="f.key"
                  :label="f.label" /></el-select
            ></el-form-item>
          </div>
          <p class="form-help">
            提交报名时保存人员、表单及费用快照。已提交的关键资料修改后需要重新审核。
          </p>
        </div>
        <div class="card">
          <h3>费用配置</h3>
          <div class="form-grid">
            <el-form-item label="计费方式"
              ><el-radio-group v-model="form.policy.feeMode"
                ><el-radio value="FREE">免费</el-radio><el-radio value="FIXED">按报名单</el-radio
                ><el-radio value="PER_PERSON">按人数</el-radio></el-radio-group
              ></el-form-item
            ><el-form-item v-if="form.policy.feeMode !== 'FREE'" label="费用（元）"
              ><el-input-number
                v-model="feeYuan"
                :min="0.01"
                :max="1000000"
                :precision="2"
                :step="1" /></el-form-item
            ><el-form-item v-if="form.policy.feeMode !== 'FREE'" label="审核与缴费顺序"
              ><el-select v-model="form.policy.paymentSequence" filterable
                ><el-option label="先审核，再缴费" value="REVIEW_FIRST" /><el-option
                  label="先缴费，再审核"
                  value="PAYMENT_FIRST" /></el-select></el-form-item
            ><el-form-item label="退款与开票"
              ><el-switch v-model="form.policy.refundsEnabled" active-text="退款" /><el-switch
                v-model="form.policy.invoicesEnabled"
                active-text="开票"
                style="margin-left: 20px"
            /></el-form-item>
          </div>
          <div v-if="form.policy.invoicesEnabled" class="form-grid">
            <el-form-item label="可申请票种"
              ><el-checkbox-group v-model="form.policy.invoiceTypes"
                ><el-checkbox value="NORMAL">普通发票</el-checkbox
                ><el-checkbox value="SPECIAL">专用发票</el-checkbox></el-checkbox-group
              ></el-form-item
            ><el-form-item label="开票额外必填资料"
              ><el-select
                v-model="form.policy.invoiceRequiredFields"
                multiple
                placeholder="按开票方要求选择"
                filterable
                ><el-option
                  v-for="(title, key) in {
                    contactName: '联系人',
                    phone: '联系电话',
                    address: '地址',
                    bankName: '开户银行',
                    bankAccount: '银行账号',
                  }"
                  :key="key"
                  :value="key"
                  :label="title" /></el-select
            ></el-form-item>
          </div>
          <el-form-item v-if="form.policy.feeMode !== 'FREE'" label="线下收款说明"
            ><el-input v-model="form.policy.paymentInstructions" type="textarea" :rows="4"
          /></el-form-item>
        </div>
        <el-button v-if="edit.editing.value" type="primary" :loading="busy" @click="save"
          >保存活动配置</el-button
        ></el-form
      >
    </div>
    <div class="panel" v-if="tab === 'fields'" :class="{ 'read-mode': !edit.editing.value }">
      <div class="card">
        <h3>可视化报名字段</h3>
        <div class="toolbar">
          <el-button v-if="edit.editing.value" type="primary" @click="editField()"
            >添加字段</el-button
          ><el-select
            v-if="edit.editing.value"
            placeholder="从全局字段导入"
            @change="importField"
            style="width: 220px"
            filterable
            ><el-option
              v-for="f in registry"
              :key="f.key"
              :value="f.key"
              :label="f.definition.label"
          /></el-select>
        </div>
        <div
          v-for="p in platformTemplates.filter((x) => form.policy.platformProfiles.includes(x.id))"
          :key="p.id"
          class="notice"
        >
          <strong>{{ p.name }} 基础信息</strong>
          <p>参赛者填写：{{ p.participant.join('、') }}</p>
          <p>系统生成：{{ p.generated.join('、') }}</p>
          <p>管理员配置：{{ p.administrator.join('、') }}</p>
        </div>
        <PaginatedTable page-key="contesteditor-form-fields" :data="form.fields"
          ><el-table-column label="字段" prop="label" /><el-table-column
            label="键名"
            prop="key"
          /><el-table-column label="作用域"
            ><template #default="{ row }">{{
              ({ PERSON: '参赛者', TEAM: '队伍', COACH: '老师', REGISTRATION: '报名单' } as Data)[
                row.scope
              ]
            }}</template></el-table-column
          ><el-table-column label="类型"
            ><template #default="{ row }">{{ label(row.type) }}</template></el-table-column
          ><el-table-column label="必填"
            ><template #default="{ row }">{{
              row.required ? '是' : '否'
            }}</template></el-table-column
          ><el-table-column v-if="edit.editing.value" label="操作" width="180"
            ><template #default="{ row }"
              ><el-button text :disabled="row.locked" @click="editField(form.fields.indexOf(row))"
                >编辑</el-button
              ><el-button
                text
                type="danger"
                :disabled="row.locked"
                @click="form.fields.splice(form.fields.indexOf(row), 1)"
                >移除</el-button
              ><el-button
                text
                v-if="form.fields.indexOf(row) > 0"
                @click="
                  form.fields.splice(
                    form.fields.indexOf(row) - 1,
                    0,
                    ...form.fields.splice(form.fields.indexOf(row), 1),
                  )
                "
                >上移</el-button
              ></template
            ></el-table-column
          ></PaginatedTable
        >
        <p class="form-help">字段配置随竞赛保存为新版本。已提交报名保留原表单版本。</p>
        <el-button v-if="edit.editing.value" type="primary" :loading="busy" @click="save"
          >保存字段配置</el-button
        >
      </div>
    </div>
    <div class="panel" v-if="tab === 'registrations' && permission('REGISTRATIONS')">
      <div class="stats">
        <div class="stat">
          <span>报名总数</span>
          <div class="value">{{ sum.total }}</div>
        </div>
        <div class="stat">
          <span>等待审核</span>
          <div class="value" style="color: #cf960c">{{ sum.pending }}</div>
        </div>
        <div class="stat">
          <span>审核通过</span>
          <div class="value" style="color: #11a77e">{{ sum.approved }}</div>
        </div>
        <div class="stat">
          <span>审核拒绝</span>
          <div class="value" style="color: #ef4444">{{ sum.rejected }}</div>
        </div>
      </div>
      <div class="toolbar">
        <el-input v-model="search" :disabled="batchBusy" placeholder="搜索姓名或队名" /><el-select
          v-model="statusFilter"
          :disabled="batchBusy"
          clearable
          placeholder="审核状态"
          filterable
          ><el-option
            v-for="s in ['DRAFT', 'PENDING', 'CORRECTION', 'APPROVED', 'REJECTED']"
            :key="s"
            :value="s"
            :label="label(s)" /></el-select
        ><el-select
          v-if="form.examSites.length"
          v-model="roster.filters.value.examSiteId"
          :disabled="batchBusy"
          clearable
          placeholder="筛选考点"
          aria-label="筛选考点"
          filterable
          ><el-option
            v-for="site in form.examSites"
            :key="site.id"
            :value="site.id"
            :label="site.name" /></el-select
        ><el-select
          v-model="roster.filters.value.participationType"
          :disabled="batchBusy"
          clearable
          placeholder="参赛性质"
          filterable
          ><el-option value="OFFICIAL" label="正式参赛" /><el-option
            value="UNOFFICIAL"
            label="非正式参赛" /></el-select
        ><el-button
          tag="a"
          v-if="permission('REGISTRATIONS')"
          :href="`/api/v1/registrations/export?contestId=${route.params.id}&${roster.query(false)}`"
          >导出名单</el-button
        ><el-button :disabled="batchBusy" @click="refreshModules">刷新</el-button
        ><el-button
          v-if="permission('ADMISSIONS') && form.modules.admissions"
          type="primary"
          :disabled="batchBlocked"
          @click="generate"
          >批量生成准考证</el-button
        ><el-button
          v-if="permission('ADMISSIONS') && form.modules.admissions"
          :disabled="batchBlocked"
          @click="downloadAdmissions"
          >下载准考证 ZIP</el-button
        ><label
          v-if="permission('ADMISSIONS') && form.modules.admissions && !form.modules.rooms"
          class="upload-label"
          >导入座位 CSV<input type="file" accept=".csv" @change="importSeats"
        /></label>
      </div>
      <div class="card">
        <el-alert
          v-if="roster.error.value"
          :title="roster.error.value"
          type="error"
          :closable="false"
        /><el-table
          ref="rosterTable"
          row-key="id"
          v-loading="roster.loading.value"
          :data="filtered"
          @selection-change="(value: Data[]) => (selected = value)"
          ><el-table-column
            reserve-selection
            type="selection"
            :selectable="() => !batchBusy && !roster.loading.value"
          /><el-table-column label="队名 / 姓名" min-width="240"
            ><template #default="{ row }"
              ><router-link :to="`/registrations/${row.id}`">{{
                row.teamName || row.people[0]?.name
              }}</router-link></template
            ></el-table-column
          ><el-table-column v-if="form.examSites.length" label="考点" min-width="160"
            ><template #default="{ row }">{{
              row.examSite?.name || '未选择'
            }}</template></el-table-column
          ><el-table-column label="参赛性质" width="120"
            ><template #default="{ row }">{{
              row.participationType === 'UNOFFICIAL' ? '非正式' : '正式'
            }}</template></el-table-column
          ><el-table-column label="人数" width="70"
            ><template #default="{ row }">{{ row.people.length }}</template></el-table-column
          ><el-table-column label="审核" width="120"
            ><template #default="{ row }">{{
              label(
                row.status === 'DRAFT'
                  ? 'DRAFT'
                  : row.status === 'CORRECTION'
                    ? 'CORRECTION'
                    : row.review,
              )
            }}</template></el-table-column
          ><el-table-column label="净到账" width="120"
            ><template #default="{ row }">{{ money(row.netPaidCents) }}</template></el-table-column
          ><el-table-column label="资格" width="90"
            ><template #default="{ row }"
              ><el-tag :type="row.eligible ? 'success' : 'info'">{{
                row.eligible ? '有效' : '待完成'
              }}</el-tag></template
            ></el-table-column
          ><el-table-column label="操作" width="270"
            ><template #default="{ row }"
              ><el-button
                v-if="permission('REGISTRATIONS') && registrationReviewPhase(row)"
                text
                type="primary"
                @click="openReview(row)"
                >{{ registrationReviewPhase(row) === 'AMEND' ? '修改审核' : '审核' }}</el-button
              ><router-link :to="`/registrations/${row.id}`">修改及查看</router-link
              ><el-button
                v-if="permission('REGISTRATIONS')"
                text
                type="danger"
                @click="removeRegistration(row)"
                >删除</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="roster.page.value"
          v-model:size="roster.pageSize.value"
          :total="roster.total.value"
          :loading="roster.loading.value || batchBusy"
        />
        <p v-if="roster.loading.value" class="form-help">
          报名列表正在更新，请稍候再执行批量操作。
        </p>
        <p v-else-if="roster.error.value" class="form-help">
          报名列表加载失败，请刷新后再执行批量操作。
        </p>
        <p v-else class="form-help">
          本次批量作用范围：{{ selected.length ? '已勾选' : '当前页' }}
          {{ batchRows.length }} 份报名， 其中 {{ batchIds.length }} 份已取得参加资格。
        </p>
      </div>
    </div>
    <div class="panel" v-if="tab === 'templates'">
      <div class="two-columns">
        <div class="card">
          <h3>LaTeX 模板</h3>
          <EditActions :session="templateEdit" />
          <el-input
            v-model="template.name"
            :disabled="!templateEdit.editing.value"
            placeholder="模板名称"
            style="margin-bottom: 15px"
          /><el-input
            v-model="template.source"
            :disabled="!templateEdit.editing.value"
            type="textarea"
            :rows="22"
            class="monospace"
            aria-label="LaTeX 模板源码"
          />
          <div class="actions">
            <el-button v-if="templateEdit.editing.value" type="primary" @click="saveTemplate"
              >保存为新版本</el-button
            ><el-button @click="previewTemplate">生成预览</el-button
            ><el-button v-if="preview" @click="checkPreview">检查预览任务</el-button
            ><a
              v-if="preview?.state === 'SUCCESS'"
              :href="`/api/v1/jobs/${preview.id}/download`"
              target="_blank"
              rel="noopener"
              >下载预览 PDF</a
            >
          </div>
          <p v-if="preview">任务：{{ label(preview.state) }} {{ preview.error }}</p>
        </div>
        <aside>
          <div class="card">
            <h3>填充字段</h3>
            <p class="form-help">
              点击插入变量。人员列表使用 <code v-pre>{{#each team.members}}</code
              >、<code v-pre>{{ this.name }}</code> 和 <code v-pre>{{/each}}</code
              >。数据自动转义。
            </p>
            <PaginatedList
              :items="availableVariables"
              page-key="template-variables"
              :always="false"
              v-slot="{ items }"
            >
              <el-button
                v-for="v in items"
                :key="v"
                text
                type="primary"
                style="display: block; margin: 0"
                :disabled="!templateEdit.editing.value"
                @click="insertVariable(v)"
                >{{ v }}</el-button
              >
            </PaginatedList>
          </div>
          <div class="card">
            <h3>模板版本</h3>
            <PaginatedList
              :items="templates"
              page-key="template-versions"
              :always="false"
              v-slot="{ items }"
            >
              <div v-for="t in items" :key="t.id" style="margin-bottom: 14px">
                <el-tag v-if="t.active" size="small">当前</el-tag>
                {{ t.contestId ? '竞赛' : '全局' }} v{{ t.version }}
                <p class="muted">{{ date(t.createdAt) }}</p>
                <el-button
                  text
                  @click="
                    templateEdit.begin();
                    template = { name: t.name, source: t.source, version: template.version };
                  "
                  >载入此版本</el-button
                >
              </div>
            </PaginatedList>
          </div>
        </aside>
      </div>
    </div>
    <div
      class="panel"
      v-if="tab === 'integrations' && permission('INTEGRATIONS') && form.modules.integrations"
    >
      <PlatformExports :contests="[form as any]" :initial-contest-id="String(route.params.id)" />
    </div>
    <el-dialog v-model="fieldDialog" title="编辑报名字段" width="600px"
      ><el-form label-position="top"
        ><div class="form-grid">
          <el-form-item label="显示名称"><el-input v-model="field.label" /></el-form-item
          ><el-form-item label="字段键名"
            ><el-input v-model="field.key" placeholder="小写字母、数字、下划线" /></el-form-item
          ><el-form-item label="作用域"
            ><el-select v-model="field.scope" filterable
              ><el-option
                v-for="(s, k) in {
                  PERSON: '参赛者',
                  TEAM: '队伍',
                  COACH: '老师',
                  REGISTRATION: '报名单',
                }"
                :key="k"
                :value="k"
                :label="s" /></el-select></el-form-item
          ><el-form-item label="类型"
            ><el-select v-model="field.type" filterable
              ><el-option
                v-for="(s, k) in {
                  text: '短文本',
                  textarea: '长文本',
                  number: '数字',
                  date: '日期',
                  select: '单选',
                  multiselect: '多选',
                  boolean: '开关',
                  file: '文件',
                  photo: '照片',
                }"
                :key="k"
                :value="k"
                :label="s" /></el-select
          ></el-form-item>
        </div>
        <el-form-item v-if="['select', 'multiselect'].includes(field.type)" label="选项（每行一个）"
          ><el-input v-model="options" type="textarea" :rows="4" /></el-form-item
        ><el-form-item label="填写提示"><el-input v-model="field.help" /></el-form-item
        ><el-form-item label="分组"><el-input v-model="field.group" /></el-form-item
        ><el-form-item label="约束"
          ><el-switch v-model="field.required" active-text="必填" /><el-switch
            v-model="field.sensitive"
            active-text="敏感字段"
            style="margin-left: 15px" /></el-form-item
        ><el-form-item label="条件显示"
          ><el-switch
            :model-value="!!field.condition"
            @update:model-value="
              (v: boolean) => (field.condition = v ? { key: '', equals: '' } : undefined)
            " />
          <div v-if="field.condition" class="form-grid">
            <el-select
              v-model="field.condition.key"
              placeholder="依据字段"
              @change="changeConditionKey"
            >
              <el-option
                v-for="source in conditionFields"
                :key="source.key"
                :label="source.label"
                :value="source.key"
              />
            </el-select>
            <el-switch
              v-if="conditionSource?.type === 'boolean'"
              v-model="field.condition.equals"
              active-text="值为是时显示"
            />
            <el-input-number
              v-else-if="conditionSource?.type === 'number'"
              v-model="field.condition.equals"
            />
            <el-select
              v-else-if="conditionSource?.type === 'multiselect'"
              v-model="field.condition.includes"
              placeholder="包含此选项时显示"
            >
              <el-option v-for="value in conditionSource.options" :key="value" :value="value" />
            </el-select>
            <el-input
              v-else
              v-model="field.condition.equals"
              placeholder="等于此值时显示"
            /></div></el-form-item></el-form
      ><template #footer
        ><el-button type="primary" @click="saveField">确定</el-button></template
      ></el-dialog
    >
  </template>
</template>
