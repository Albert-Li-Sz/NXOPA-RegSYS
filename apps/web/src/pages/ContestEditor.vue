<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  policySchema,
  defaultFields,
  defaultTemplate,
  platformTemplates,
  mergePlatformFields,
} from '@contest-center/contracts';
import { api, date, label, money, downloadArchive } from '../api';
import type { Data, FieldDefinition } from '../types';
import MarkdownEditor from '../components/MarkdownEditor.vue';
import PlatformBindings from '../components/PlatformBindings.vue';
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
  instances = ref<Data[]>([]),
  registry = ref<Data[]>([]),
  preview = ref<Data>();
const form = ref<Data>({
  title: '',
  season: '2026',
  description: '',
  descriptionFormat: 'MARKDOWN',
  announcement: '',
  location: '',
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
const template = ref({ name: '竞赛准考证模板', source: defaultTemplate });
const selected = ref<Data[]>([]),
  statusFilter = ref(''),
  search = ref(''),
  fieldDialog = ref(false),
  editingField = ref(-1),
  field = ref<Data>({}),
  options = ref('');
const permission = (item: Parameters<typeof canManage>[1]) =>
  isNew.value || canManage(String(route.params.id), item);
const filtered = computed(() => rows.value);
watch([statusFilter, search], ([review, value]) => {
  roster.filters.value = { ...roster.filters.value, review, search: value };
  selected.value = [];
});
watch([roster.page, roster.pageSize, roster.filters], () => (selected.value = []), { deep: true });
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
      form.value.policy = policySchema.parse(form.value.policy);
      if (tab.value === 'settings' && !permission('CONTEST')) tab.value = 'registrations';
      await refreshModules();
    }
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
    if (['templates', 'registrations'].includes(tab.value) && permission('ADMISSIONS')) {
      templates.value = await api(`/admissions/templates?contestId=${route.params.id}`);
      const active =
        templates.value.find((t) => t.contestId === route.params.id && t.active) ??
        templates.value.find((t) => t.active);
      if (active) template.value = { name: active.name, source: active.source };
    }
    if (tab.value === 'integrations') instances.value = await api('/integrations/instances');
  } catch (e) {
    moduleError.value = e instanceof Error ? e.message : '管理数据加载失败';
  }
}
watch(tab, () => {
  if (!isNew.value) refreshModules();
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
    const c = await api(
      isNew.value ? '/contests' : `/contests/${route.params.id}`,
      isNew.value ? 'POST' : 'PUT',
      form.value,
    );
    ElMessage.success('竞赛配置已保存');
    if (isNew.value) router.replace(`/admin/contests/${c.id}`);
    else form.value = await api(`/contests/${c.id}`);
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
  const f = {
    ...field.value,
    options: options.value.split('\n').filter(Boolean),
  } as FieldDefinition;
  if (editingField.value < 0) form.value.fields.push(f);
  else form.value.fields[editingField.value] = f;
  fieldDialog.value = false;
}
function importField(key: string) {
  const item = registry.value.find((x) => x.key === key);
  if (item) form.value.fields.push(JSON.parse(JSON.stringify(item.definition)));
}
async function saveTemplate() {
  await api('/admissions/templates', 'POST', { ...template.value, contestId: route.params.id });
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
  const ids = selected.value.length
    ? selected.value.filter((r) => r.eligible).map((r) => r.id)
    : rows.value.filter((r) => r.eligible).map((r) => r.id);
  if (!ids.length) {
    ElMessage.warning('请选择已取得资格的报名');
    return;
  }
  const { value } = await ElMessageBox.prompt(
    '考场 / 座位起始号（连续分配），例如 A101 / 1',
    '批量生成准考证',
  );
  const [room, seat] = value.split('/').map((x) => x.trim());
  await api('/admissions/generate', 'POST', {
    registrationIds: ids,
    location: form.value.location,
    room,
    seat,
    incrementSeats: true,
  });
  ElMessage.success('生成任务已入队');
}
async function downloadAdmissions() {
  const registrationIds = (selected.value.length ? selected.value : filtered.value)
    .filter((r) => r.eligible)
    .map((r) => r.id);
  if (!registrationIds.length) {
    ElMessage.warning('请选择已取得资格且准考证已生成的报名');
    return;
  }
  if (registrationIds.length > 1000) {
    ElMessage.warning('每次最多下载 1000 份，请分批选择');
    return;
  }
  await downloadArchive('/admissions/batch', { registrationIds }, 'admissions.zip');
}
const availableVariables = computed(() => [
  'contest.title',
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
    .map((f: FieldDefinition) => `participant.assets.${f.key}`),
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
      <router-link to="/admin/contests">竞赛中心</router-link><span>／</span
      ><span>{{ isNew ? '创建竞赛' : form.title }}</span>
    </div>
    <div class="page-heading" style="margin-top: 24px">
      <div>
        <h1>{{ isNew ? '创建竞赛' : form.title }}</h1>
        <p class="subtitle">配置报名规则，处理审核、准考证和平台联动</p>
      </div>
      <el-button v-if="!isNew" @click="router.push(`/contests/${route.params.id}`)"
        >查看公开页面</el-button
      >
    </div>
    <el-tabs v-model="tab"
      ><el-tab-pane v-if="permission('CONTEST')" label="竞赛设置" name="settings" /><el-tab-pane
        v-if="permission('CONTEST')"
        label="报名字段"
        name="fields" /><el-tab-pane
        v-if="!isNew"
        label="报名管理"
        name="registrations" /><el-tab-pane
        v-if="!isNew && permission('ADMISSIONS')"
        label="准考证模板"
        name="templates" /><el-tab-pane
        v-if="!isNew && permission('INTEGRATIONS')"
        label="平台联动"
        name="integrations" /><el-tab-pane
        v-if="!isNew && permission('FILES')"
        label="竞赛附件"
        name="files"
    /></el-tabs>
    <el-alert v-if="moduleError" :title="moduleError" type="error" :closable="false"
      ><el-button @click="refreshModules">重新加载</el-button></el-alert
    >
    <FileLibrary
      v-if="tab === 'files' && permission('FILES')"
      :contest-id="String(route.params.id)"
    />
    <div class="panel" v-if="tab === 'settings'">
      <el-form label-position="top"
        ><div class="card">
          <h3>基本信息</h3>
          <div class="form-grid">
            <el-form-item label="竞赛名称" required for="contest-title"
              ><el-input id="contest-title" v-model="form.title" /></el-form-item
            ><el-form-item label="赛季" for="contest-season"
              ><el-input id="contest-season" v-model="form.season" /></el-form-item
            ><el-form-item label="比赛开始时间"
              ><el-date-picker
                v-model="form.startsAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
            ><el-form-item label="比赛地点"><el-input v-model="form.location" /></el-form-item
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
                v-for="state in ['APPROVED', 'PENDING', 'CORRECTION', 'REJECTED']"
                :key="state"
                :value="state"
                >{{ label(state) }}</el-checkbox
              ></el-checkbox-group
            >
            <p class="form-help">
              公示仅包含队名、学校、队员姓名、指导老师、排名与审核状态。
            </p></el-form-item
          >
          <el-form-item label="竞赛介绍"
            ><MarkdownEditor
              v-model="form.description"
              v-model:format="form.descriptionFormat" /></el-form-item
          ><el-form-item label="公告"
            ><el-input v-model="form.announcement" type="textarea" :rows="3" /></el-form-item
          ><el-switch v-model="form.archived" active-text="归档竞赛" />
        </div>
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
            ><el-form-item v-if="form.policy.feeMode !== 'FREE'" label="费用（分，100 分 = 1 元）"
              ><el-input-number
                v-model="form.policy.feeCents"
                :min="1"
                :max="100000000"
                :step="100" /></el-form-item
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
        <el-button type="primary" :loading="busy" @click="save">保存竞赛配置</el-button></el-form
      >
    </div>
    <div class="panel" v-if="tab === 'fields'">
      <div class="card">
        <h3>可视化报名字段</h3>
        <div class="toolbar">
          <el-button type="primary" @click="editField()">添加字段</el-button
          ><el-select
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
        <el-table :data="form.fields"
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
          ><el-table-column label="操作" width="180"
            ><template #default="{ row, $index }"
              ><el-button text :disabled="row.locked" @click="editField($index)">编辑</el-button
              ><el-button
                text
                type="danger"
                :disabled="row.locked"
                @click="form.fields.splice($index, 1)"
                >移除</el-button
              ><el-button
                text
                v-if="$index > 0"
                @click="form.fields.splice($index - 1, 0, ...form.fields.splice($index, 1))"
                >上移</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <p class="form-help">字段配置随竞赛保存为新版本。已提交报名保留原表单版本。</p>
        <el-button type="primary" :loading="busy" @click="save">保存字段配置</el-button>
      </div>
    </div>
    <div class="panel" v-if="tab === 'registrations'">
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
        <el-input v-model="search" placeholder="搜索姓名或队名" /><el-select
          v-model="statusFilter"
          clearable
          placeholder="审核状态"
          filterable
          ><el-option
            v-for="s in ['PENDING', 'APPROVED', 'REJECTED']"
            :key="s"
            :value="s"
            :label="label(s)" /></el-select
        ><el-select
          v-model="roster.filters.value.participationType"
          clearable
          placeholder="参赛性质"
          filterable
          ><el-option value="OFFICIAL" label="正式参赛" /><el-option
            value="UNOFFICIAL"
            label="非正式参赛" /></el-select
        ><a
          :href="`/api/v1/registrations/export?contestId=${route.params.id}&${roster.query(false)}`"
          ><el-button>导出名单</el-button></a
        ><el-button @click="refreshModules">刷新</el-button
        ><el-button type="primary" @click="generate">批量生成准考证</el-button
        ><el-button @click="downloadAdmissions">下载准考证 ZIP</el-button
        ><label class="upload-label"
          >导入座位 CSV<input type="file" accept=".csv" @change="importSeats"
        /></label>
      </div>
      <div class="card">
        <el-alert
          v-if="roster.error.value"
          :title="roster.error.value"
          type="error"
          :closable="false"
        /><el-table :data="filtered" @selection-change="(value: Data[]) => (selected = value)"
          ><el-table-column type="selection" /><el-table-column label="队名 / 姓名" min-width="240"
            ><template #default="{ row }"
              ><router-link :to="`/registrations/${row.id}`">{{
                row.teamName || row.people[0]?.name
              }}</router-link></template
            ></el-table-column
          ><el-table-column label="参赛性质" width="120"
            ><template #default="{ row }">{{
              row.participationType === 'UNOFFICIAL' ? '非正式' : '正式'
            }}</template></el-table-column
          ><el-table-column label="人数" width="70"
            ><template #default="{ row }">{{ row.people.length }}</template></el-table-column
          ><el-table-column label="审核" width="120"
            ><template #default="{ row }">{{ label(row.review) }}</template></el-table-column
          ><el-table-column label="净到账" width="120"
            ><template #default="{ row }">{{ money(row.netPaidCents) }}</template></el-table-column
          ><el-table-column label="资格" width="90"
            ><template #default="{ row }"
              ><el-tag :type="row.eligible ? 'success' : 'info'">{{
                row.eligible ? '有效' : '待完成'
              }}</el-tag></template
            ></el-table-column
          ><el-table-column label="操作" width="110"
            ><template #default="{ row }"
              ><router-link :to="`/registrations/${row.id}`">查看 / 审核</router-link></template
            ></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="roster.page.value"
          v-model:size="roster.pageSize.value"
          :total="roster.total.value"
          :loading="roster.loading.value"
        />
        <p class="form-help">批量操作作用于已选择的报名；未选择时使用当前页符合条件的报名。</p>
      </div>
    </div>
    <div class="panel" v-if="tab === 'templates'">
      <div class="two-columns">
        <div class="card">
          <h3>LaTeX 模板</h3>
          <el-input
            v-model="template.name"
            placeholder="模板名称"
            style="margin-bottom: 15px"
          /><el-input
            v-model="template.source"
            type="textarea"
            :rows="22"
            class="monospace"
            aria-label="LaTeX 模板源码"
          />
          <div class="actions">
            <el-button type="primary" @click="saveTemplate">保存为新版本</el-button
            ><el-button @click="previewTemplate">生成预览</el-button
            ><el-button v-if="preview" @click="checkPreview">检查预览任务</el-button
            ><a
              v-if="preview?.state === 'SUCCESS'"
              :href="`/api/v1/jobs/${preview.id}/download`"
              target="_blank"
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
            <el-button
              v-for="v in availableVariables"
              :key="v"
              text
              type="primary"
              style="display: block; margin: 0"
              @click="insertVariable(v)"
              >{{ v }}</el-button
            >
          </div>
          <div class="card">
            <h3>模板版本</h3>
            <div v-for="t in templates" :key="t.id" style="margin-bottom: 14px">
              <el-tag v-if="t.active" size="small">当前</el-tag>
              {{ t.contestId ? '竞赛' : '全局' }} v{{ t.version }}
              <p class="muted">{{ date(t.createdAt) }}</p>
              <el-button text @click="template = { name: t.name, source: t.source }"
                >载入此版本</el-button
              >
            </div>
          </div>
        </aside>
      </div>
    </div>
    <div class="panel" v-if="tab === 'integrations'">
      <PlatformBindings
        :contests="[form as any]"
        :instances="instances"
        :initial-contest-id="String(route.params.id)"
        @saved="form = $event"
      />
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
            <el-input v-model="field.condition.key" placeholder="依据字段键名" /><el-input
              v-model="field.condition.equals"
              placeholder="等于此值时显示"
            /></div></el-form-item></el-form
      ><template #footer
        ><el-button type="primary" @click="saveField">确定</el-button></template
      ></el-dialog
    >
  </template>
</template>
