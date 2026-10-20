<script setup lang="ts">
import PaginatedTable from '../components/PaginatedTable.vue';
import PaginatedList from '../components/PaginatedList.vue';
import { ref, shallowRef, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, auth, money, date, label, upload } from '../api';
import type { RegistrationView, PersonView, Data } from '../types';
import { useEditSession, mayLeaveEdits } from '../composables/useEditSession';
import EditActions from '../components/EditActions.vue';
import RegistrationReadout from '../components/RegistrationReadout.vue';
import RegistrationReview from '../components/RegistrationReview.vue';
import FileLibrary from '../components/FileLibrary.vue';
import MailDelivery from '../components/MailDelivery.vue';
import { canManage, ownUser } from '../permissions';
import InvoiceApplication from '../components/InvoiceApplication.vue';
import ListPagination from '../components/ListPagination.vue';
import { usePagedList } from '../composables/usePagedList';
import { policySchema } from '@contest-center/contracts';
import DynamicFields from '../components/DynamicFields.vue';
const route = useRoute(),
  r = shallowRef<RegistrationView>(),
  form = ref<{
    examSiteId: string | null;
    teamName: string;
    teamEnglishName: string;
    participationType: string;
    organization: { name: string; shortName: string; country: string; icpcId: string };
    answers: Data;
    people: PersonView[];
    coaches: Data[];
  }>({
    examSiteId: null,
    teamName: '',
    teamEnglishName: '',
    participationType: 'OFFICIAL',
    organization: { name: '', shortName: '', country: 'CHN', icpcId: '' },
    answers: {},
    people: [],
    coaches: [],
  }),
  tab = ref(String(route.query.tab ?? 'registration')),
  busy = ref(false),
  loadError = ref(''),
  link = ref(''),
  credentials = ref<Data[]>([]),
  bindings = ref<Data[]>([]);
const edit = useEditSession(form),
  router = useRouter(),
  reviewOpen = ref(false);
const rank = ref<{ rank: number | null }>({ rank: null }),
  rankEdit = useEditSession(rank);
const invoiceTotal = computed(() => r.value?.invoiceIssuedCents ?? 0);
const invoiceApplication = ref(false),
  invoiceDetail = ref<Data>();
const invoiceApplicationForm = ref<InstanceType<typeof InvoiceApplication>>();
async function closeInvoiceApplication(done: () => void) {
  if (!invoiceApplicationForm.value || (await invoiceApplicationForm.value.mayClose())) done();
}
const voucherPage = usePagedList(
    'vouchers',
    () => `/registrations/${route.params.id}/finance/vouchers`,
  ),
  ledgerPage = usePagedList('ledger', () => `/registrations/${route.params.id}/finance/ledger`),
  refundPage = usePagedList('refunds', () => `/registrations/${route.params.id}/finance/refunds`),
  invoicePage = usePagedList(
    'invoices',
    () => `/registrations/${route.params.id}/finance/invoices`,
  );
async function loadFinance() {
  if (r.value)
    await Promise.all([
      voucherPage.load(),
      ledgerPage.load(),
      refundPage.load(),
      invoicePage.load(),
    ]);
}
watch(tab, (value) => {
  if (value === 'finance') loadFinance();
});
const manager = computed(() => !!r.value && canManage(r.value.contestId, 'REGISTRATIONS'));
const financeManager = computed(() => !!r.value && canManage(r.value.contestId, 'FINANCE'));
const financeReviewer = computed(() => financeManager.value && !ownUser(r.value?.ownerId ?? ''));
const admissionManager = computed(() => !!r.value && canManage(r.value.contestId, 'ADMISSIONS'));
const integrationManager = computed(
  () => !!r.value && canManage(r.value.contestId, 'INTEGRATIONS'),
);
const editor = computed(
  () =>
    manager.value ||
    (r.value && ownUser(r.value.ownerId)) ||
    r.value?.coaches.some((c) => ownUser(c.userId)),
);
const policy = computed(() =>
  r.value ? policySchema.parse(r.value.policySnapshot ?? r.value.contest.policy) : undefined,
);
const platformProfiles = computed(() =>
  !r.value?.contest.modules.integrations
    ? []
    : [
        ...new Set([
          ...(policy.value?.platformProfiles ?? []),
          ...((r.value ? policySchema.parse(r.value.contest.policy).platformProfiles : []) ?? []),
        ]),
      ],
);
const invoicePolicy = computed(() =>
  r.value ? policySchema.parse(r.value.contest.policy) : undefined,
);
const canSave = computed(() => !busy.value && edit.editing.value && !!r.value?.actions.edit);
const savingDraft = computed(() => r.value?.status === 'DRAFT' && r.value.actions.requestFinance);
const canUploadVoucher = computed(
  () =>
    !!r.value &&
    r.value.actions.requestFinance &&
    r.value.status === 'SUBMITTED' &&
    r.value.feeCents > 0 &&
    r.value.review !== 'REJECTED' &&
    (policy.value?.paymentSequence !== 'REVIEW_FIRST' ||
      !(policy.value.manualReview || r.value.participationType === 'UNOFFICIAL') ||
      r.value.review === 'APPROVED'),
);
async function saveRank() {
  await api(`/registrations/${r.value!.id}/public-rank`, 'PUT', {
    rank: rank.value.rank || null,
    expectedRank: r.value!.publicRank,
  });
  rankEdit.finish();
  await refresh();
  ElMessage.success('排名已保存');
}
async function reload() {
  if (!(await edit.mayLeave()) || !(await rankEdit.mayLeave())) return;
  edit.finish();
  rankEdit.finish();
  await refresh();
}
async function openReview() {
  if (!(await edit.mayLeave())) return;
  edit.finish();
  await refresh();
  reviewOpen.value = true;
}
let refreshSequence = 0;
async function refresh() {
  const sequence = ++refreshSequence;
  try {
    loadError.value = '';
    const next = await api(`/registrations/${route.params.id}?history=false`);
    if (sequence !== refreshSequence) return;
    r.value = next;
    const x = r.value!;
    if (!rankEdit.editing.value) rank.value = { rank: x.publicRank };
    form.value = JSON.parse(
      JSON.stringify({
        examSiteId: x.examSiteId,
        teamName: x.teamName,
        teamEnglishName: x.teamEnglishName,
        participationType: x.participationType,
        organization: x.organization ?? { name: '', shortName: '', country: 'CHN', icpcId: '' },
        answers: { registration: {}, team: {}, ...x.answers },
        people: x.people,
        coaches: x.coaches,
      }),
    );
    if (integrationManager.value)
      bindings.value = await api(`/integrations/bindings?contestId=${x.contestId}`);
    if (tab.value === 'finance') await loadFinance();
  } catch (e) {
    if (sequence !== refreshSequence) return;
    if (route.query.tab === 'finance') {
      try {
        await api(`/finance/accounts/${route.params.id}`);
        await router.replace(`/finance/${route.params.id}`);
        return;
      } catch {}
    }
    loadError.value = e instanceof Error ? e.message : '报名暂时无法加载';
    r.value = undefined;
  }
}
onMounted(async () => {
  await refresh();
  if (route.query.edit === '1' && r.value?.actions.edit) edit.begin();
});
async function action(path: string, body: Data = {}) {
  busy.value = true;
  try {
    const result = await api(path, 'POST', body);
    await refresh();
    return result;
  } finally {
    busy.value = false;
  }
}
async function save() {
  const wasDraft = savingDraft.value;
  busy.value = true;
  try {
    await api(`/registrations/${r.value!.id}`, 'PUT', {
      ...form.value,
      organization: form.value.organization?.name ? form.value.organization : null,
      version: r.value!.version,
    });
    await refresh();
    edit.finish();
    ElMessage.success(wasDraft ? '报名草稿已保存' : '报名修改已保存');
  } finally {
    busy.value = false;
  }
}
async function submit() {
  const selectedSite = edit.editing.value ? form.value.examSiteId : r.value!.examSiteId;
  if (r.value!.contest.examSites.length && !selectedSite) {
    if (!edit.editing.value) edit.begin();
    ElMessage.warning('请选择参赛考点');
    return;
  }
  if (edit.editing.value) await save();
  await action(`/registrations/${r.value!.id}/submit`, { version: r.value!.version });
  ElMessage.success('报名已提交');
}
async function cancel() {
  await ElMessageBox.confirm(
    '报名资料、成员关联及准考证将永久删除；已付款的财务单据独立保留，可继续申请退款。确认取消？',
    '永久取消报名',
    { type: 'warning', confirmButtonText: '永久取消' },
  );
  const result = await api(`/registrations/${r.value!.id}/cancel`, 'POST', {
    version: r.value!.version,
  });
  edit.finish();
  rankEdit.finish();
  await router.push(result.financeAccountId ? `/registrations?tab=finance` : '/registrations');
}
async function removeRegistration() {
  const { value } = await ElMessageBox.prompt(
    '报名资料及准考证将永久删除，财务独立保留。请填写删除原因。',
    '删除报名',
    {
      inputType: 'textarea',
      inputValidator: (value: string) => !!value.trim() || '请填写删除原因',
      type: 'warning',
      confirmButtonText: '永久删除',
    },
  );
  await api(`/registrations/${r.value!.id}`, 'DELETE', {
    version: r.value!.version,
    reason: value,
  });
  edit.finish();
  rankEdit.finish();
  await router.push(`/admin/contests/${r.value!.contestId}?tab=registrations`);
}
async function invite(kind: string) {
  if (edit.dirty.value) await save();
  const result = await action(`/registrations/${r.value!.id}/invites`, { kind });
  link.value = result.url;
  edit.begin();
}
async function copy() {
  await navigator.clipboard.writeText(link.value);
  ElMessage.success('链接已复制');
}
async function removeCoach(id: string) {
  if (edit.dirty.value) await save();
  await api(`/registrations/${r.value!.id}/coaches/${id}`, 'DELETE', { version: r.value!.version });
  await refresh();
  edit.begin();
}
function addPerson() {
  form.value.people.push({ name: '', email: '', captain: false, confirmed: true, answers: {} });
}
const newVoucher = () => ({
  amount: 0,
  channel: '银行转账',
  payer: '',
  reference: '',
  paidAt: new Date().toISOString(),
  attachmentId: '',
});
const voucher = ref<Data>(newVoucher()),
  voucherDialog = ref(false);
async function attach(e: Event, model: Data) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    model.attachmentId = '';
    const f = await upload(file);
    if (input.files?.[0] !== file) return;
    model.attachmentId = f.id;
    ElMessage.success('文件已上传');
  }
}
async function sendVoucher() {
  await action(`/finance/${r.value!.id}/vouchers`, {
    ...voucher.value,
    amountCents: Math.round(voucher.value.amount * 100),
  });
  voucherDialog.value = false;
  voucher.value = newVoucher();
}
async function financialRequest(type: 'refunds' | 'invoices') {
  if (type === 'invoices') {
    invoiceApplication.value = true;
    return;
  }
  const { value } = await ElMessageBox.prompt(
    type === 'refunds' ? '输入退款金额（元）' : '输入开票金额（元）',
    type === 'refunds' ? '申请退款' : '申请开票',
    { inputPattern: /^\d+(\.\d{1,2})?$/, inputErrorMessage: '请填写有效金额' },
  );
  const amountCents = Math.round(Number(value) * 100);
  if (type === 'refunds') {
    const result = await ElMessageBox.prompt('说明退款原因', '退款原因');
    await action(`/finance/${r.value!.id}/refunds`, { amountCents, reason: result.value });
  }
}
const invoiceFile = ref<Data>({}),
  invoiceDialog = ref(false),
  selectedInvoice = ref('');
function openInvoice(id: string) {
  invoiceFile.value = {};
  selectedInvoice.value = id;
  invoiceDialog.value = true;
}
async function issue() {
  await action(`/finance/invoices/${selectedInvoice.value}/review`, {
    decision: 'ISSUED',
    attachmentId: invoiceFile.value.attachmentId,
  });
  invoiceDialog.value = false;
}
async function completeRefund(id: string) {
  const { value } = await ElMessageBox.prompt('记录已实际退款的银行 / 渠道参考号', '记录线下退款');
  await action(`/finance/refunds/${id}/review`, { decision: 'COMPLETED', reference: value });
}
async function confirmVoucher(row: Data) {
  await ElMessageBox.confirm(
    `确认凭证申报金额 ${money(row.amountCents)} 已实际到账？金额不符请退回凭证。`,
    '核账确认',
  );
  const reference =
    row.reference ||
    (
      await ElMessageBox.prompt('填写银行或支付平台的交易参考号', '到账参考号', {
        inputValidator: (value: string) => !!value.trim() || '请填写参考号',
      })
    ).value;
  await action(`/finance/vouchers/${row.id}/review`, {
    decision: 'CONFIRMED',
    reference,
  });
}
async function rejectVoucher(id: string) {
  const { value } = await ElMessageBox.prompt('请填写原因', '拒绝凭证');
  await action(`/finance/vouchers/${id}/review`, { decision: 'REJECTED', reason: value });
}
async function reverse(id: string) {
  const { value } = await ElMessageBox.prompt('请说明冲正原因，系统会保留原始账目', '冲正确认');
  await action(`/finance/ledger/${id}/reverse`, { reason: value });
}
async function generate() {
  if (r.value!.contest.modules.rooms) {
    await action('/admissions/generate', { registrationIds: [r.value!.id] });
  } else {
    const { value } = await ElMessageBox.prompt('填写考场 / 座位，例如 A101 / 12', '生成准考证');
    const [room, seat] = value.split('/').map((x) => x.trim());
    await action('/admissions/generate', { registrationIds: [r.value!.id], room, seat });
  }
  ElMessage.success('生成任务已入队，请刷新查看结果');
}
async function memberSave(id: string, index: number) {
  await api(`/registrations/${r.value!.id}/people/${id}`, 'PUT', {
    version: r.value!.version,
    name: form.value.people[index].name,
    answers: form.value.people[index].answers,
  });
  await refresh();
  edit.finish();
}
</script>
<template>
  <el-result v-if="loadError" icon="warning" title="无法查看报名" :sub-title="loadError"
    ><template #extra
      ><el-button @click="refresh">重新加载</el-button
      ><router-link to="/"><el-button type="primary">返回首页</el-button></router-link></template
    ></el-result
  >
  <div v-else-if="!r" class="loading"><el-skeleton :rows="8" animated /></div>
  <template v-else
    ><div class="crumb">
      <router-link to="/contests">活动及竞赛列表</router-link><span>／</span
      ><router-link :to="`/contests/${r.contestId}`">{{ r.contest.title }}</router-link
      ><span>／</span
      ><span>{{ ownUser(r.ownerId) ? '我的报名' : manager ? '报名管理' : '报名详情' }}</span>
    </div>
    <div v-if="r.number && r.submittedAt" class="notice">
      报名编号：#{{ r.number }} · 首次提交：{{ date(r.submittedAt) }}
    </div>
    <h1 class="detail-title">{{ r.teamName || r.people[0]?.name || '报名资料' }}</h1>
    <p class="subtitle">
      比赛时间：{{ date(r.contest.startsAt) }} ·
      {{ policy?.mode === 'TEAM' ? '团队报名' : '个人报名' }}
    </p>
    <div class="toolbar">
      <el-tag>{{ label(r.status) }}</el-tag
      ><el-tag
        v-if="r.status === 'SUBMITTED'"
        :type="r.review === 'APPROVED' ? 'success' : r.review === 'REJECTED' ? 'danger' : 'warning'"
        >{{ label(r.review) }}</el-tag
      ><el-tag
        v-if="policy?.allowUnofficial"
        :type="r.participationType === 'UNOFFICIAL' ? 'warning' : 'info'"
        >{{ r.participationType === 'UNOFFICIAL' ? '非正式参赛' : '正式参赛' }}</el-tag
      ><el-tag :type="r.eligible ? 'success' : 'info'">{{
        r.eligible ? '参加资格已确认' : '参加资格待完成'
      }}</el-tag
      ><el-button text @click="reload">刷新状态</el-button>
    </div>
    <div v-if="r.formUpdated" class="notice">报名表单已更新，请检查新增字段并填写后再提交。</div>
    <div v-if="r.reviewReason" class="notice">审核意见：{{ r.reviewReason }}</div>
    <el-tabs v-model="tab" :before-leave="mayLeaveEdits"
      ><el-tab-pane label="报名资料" name="registration" /><el-tab-pane
        v-if="r.contest.modules.admissions"
        label="准考证"
        name="admissions" /><el-tab-pane label="财务" name="finance" /><el-tab-pane
        v-if="r.contest.modules.integrations"
        label="比赛账号"
        name="accounts" /><el-tab-pane
        :label="policy?.mode === 'TEAM' ? '队伍附件' : '报名附件'"
        name="files" /><el-tab-pane label="邮件通知" name="mail"
    /></el-tabs>
    <FileLibrary
      v-if="tab === 'files'"
      :registration-id="r.id"
      :can-upload="
        canManage(r.contestId, 'FILES') ||
        ownUser(r.ownerId) ||
        r.people.some((p) => p.active !== false && p.userId && ownUser(p.userId)) ||
        r.coaches.some((c) => ownUser(c.userId))
      "
    />
    <MailDelivery v-if="tab === 'mail'" :resource-id="r.id" />
    <div class="panel" v-if="tab === 'registration'">
      <div class="stats">
        <div class="stat">
          <span>参加人数</span>
          <div class="value">{{ r.people.length }}</div>
          <span class="hint">{{ policy?.minMembers }}–{{ policy?.maxMembers }} 人</span>
        </div>
        <div class="stat">
          <span>关联老师</span>
          <div class="value">{{ r.coaches.length }}</div>
          <span class="hint">{{
            policy?.coachMode === 'REQUIRED'
              ? '必须关联'
              : policy?.coachMode === 'DISABLED'
                ? '无需老师'
                : '可选老师'
          }}</span>
        </div>
        <div class="stat">
          <span>应付金额</span>
          <div class="value">{{ money(r.feeCents) }}</div>
          <span class="hint">提交时确定费用</span>
        </div>
        <div class="stat">
          <span>净到账金额</span>
          <div class="value">{{ money(r.netPaidCents) }}</div>
          <span class="hint">以实际核账为准</span>
        </div>
      </div>
      <EditActions
        :session="edit"
        :allow="r.actions.edit || r.actions.editOwnMember"
        label="编辑报名资料"
      />
      <el-alert
        v-if="!r.actions.edit && !r.actions.editOwnMember"
        :title="r.actions.editReason"
        type="info"
        :closable="false"
      />
      <RegistrationReadout v-if="!edit.editing.value" :registration="r" />
      <el-form v-else label-position="top" :disabled="busy"
        ><div v-if="r.contest.examSites.length" class="card">
          <h3>参赛考点</h3>
          <el-form-item label="选择考点" for="registration-exam-site" required>
            <el-select
              id="registration-exam-site"
              v-model="form.examSiteId"
              :disabled="!canSave"
              placeholder="请选择参赛考点"
              filterable
            >
              <el-option
                v-for="site in r.contest.examSites.filter(
                  (s) => s.enabled || s.id === r!.examSiteId,
                )"
                :key="site.id"
                :value="site.id"
                :label="site.name + (site.enabled ? '' : '（已停用，保留原选择）')"
                :disabled="!site.enabled && form.examSiteId !== site.id"
              />
            </el-select>
          </el-form-item>
          <p v-if="form.examSiteId" class="form-help">
            {{
              r.contest.examSites.find((s) => s.id === form.examSiteId)?.address ||
              '该考点暂未填写详细地址'
            }}
          </p>
          <p class="form-help">团队成员共用所选考点。更换考点后需重新提交审核并安排座位。</p>
          <el-alert
            v-if="!r.contest.examSites.some((s) => s.enabled) && !r.examSiteId"
            title="暂无开放选择的考点，请联系主办方"
            type="warning"
            :closable="false"
          />
        </div>
        <el-alert
          v-if="platformProfiles.length && !r.organization"
          title="评测平台基础信息待补充"
          description="请补充代表学校／单位与联系人邮箱。历史报名保留原表单；修改资料后需要重新提交审核。"
          type="info"
          :closable="false"
        />
        <div class="card" v-if="policy?.allowUnofficial || platformProfiles.length">
          <h3>参赛性质与代表单位</h3>
          <div class="form-grid">
            <el-form-item label="参赛性质" v-if="policy?.allowUnofficial"
              ><el-radio-group v-model="form.participationType" :disabled="!canSave"
                ><el-radio value="OFFICIAL">正式参赛</el-radio
                ><el-radio value="UNOFFICIAL">非正式参赛</el-radio></el-radio-group
              ></el-form-item
            ><template v-if="platformProfiles.length || form.organization?.name"
              ><el-form-item label="代表学校／单位全称" required for="organization-name"
                ><el-input
                  id="organization-name"
                  v-model="form.organization.name"
                  :disabled="!canSave" /></el-form-item
              ><el-form-item label="学校／单位简称" required for="organization-short"
                ><el-input
                  id="organization-short"
                  v-model="form.organization.shortName"
                  :disabled="!canSave" /></el-form-item
              ><el-form-item label="国家／地区代码" required for="organization-country"
                ><el-input
                  id="organization-country"
                  v-model="form.organization.country"
                  :disabled="!canSave"
                  placeholder="CHN"
                  maxlength="3" /></el-form-item
              ><el-form-item label="学校 ICPC 编号（可选）" for="organization-icpc"
                ><el-input
                  id="organization-icpc"
                  v-model="form.organization.icpcId"
                  :disabled="!canSave" /></el-form-item
            ></template>
          </div>
          <p class="form-help" v-if="form.participationType === 'UNOFFICIAL'">
            非正式参赛须经管理员审核，缴费、老师关联和准考证规则相同。
          </p>
          <p class="form-help" v-if="platformProfiles.length">
            代表单位用于评测平台学校映射；成员个人学校资料单独填写。
          </p>
        </div>
        <div class="card" v-if="policy?.mode === 'TEAM'">
          <h3>队伍信息</h3>
          <div class="form-grid">
            <el-form-item label="队伍名称" required for="team-name"
              ><el-input
                id="team-name"
                v-model="form.teamName"
                :disabled="!canSave" /></el-form-item
            ><el-form-item label="英文队名" for="team-english"
              ><el-input id="team-english" v-model="form.teamEnglishName" :disabled="!canSave"
            /></el-form-item>
          </div>
          <DynamicFields
            :fields="r.fields"
            scope="TEAM"
            :answers="form.answers.team"
            :registration-id="r.id"
            :disabled="!canSave"
          />
        </div>
        <div class="card" v-if="r.fields.some((f) => f.scope === 'REGISTRATION')">
          <h3>报名信息</h3>
          <DynamicFields
            :fields="r.fields"
            scope="REGISTRATION"
            :answers="form.answers.registration"
            :registration-id="r.id"
            :disabled="!canSave"
          />
        </div>
        <PaginatedList
          :items="form.people"
          page-key="registration-members"
          :always="false"
          v-slot="{ entries }"
        >
          <div v-for="{ row: person, index } in entries" :key="person.id || index" class="card">
            <div class="member-heading">
              <h3>
                {{ policy?.mode === 'TEAM' ? `成员 ${index + 1}` : '报名人信息' }}
                <el-tag v-if="person.captain && policy?.mode === 'TEAM'" size="small">队长</el-tag>
              </h3>
              <el-button
                v-if="!person.captain && canSave"
                text
                type="danger"
                @click="form.people.splice(index, 1)"
                >移除成员</el-button
              >
            </div>
            <div class="form-grid">
              <el-form-item label="姓名" required :for="`person-${index}-name`"
                ><el-input
                  :id="`person-${index}-name`"
                  v-model="person.name"
                  :disabled="
                    !canSave &&
                    !(
                      edit.editing.value &&
                      r.actions.editOwnMember &&
                      person.userId === auth.user?.id
                    )
                  " /></el-form-item
              ><el-form-item label="邮箱" :for="`person-${index}-email`"
                ><el-input
                  :id="`person-${index}-email`"
                  v-model="person.email"
                  :disabled="!!person.userId || !canSave"
              /></el-form-item>
            </div>
            <DynamicFields
              :fields="r.fields"
              scope="PERSON"
              :answers="person.answers"
              :prefix="`member-${index}`"
              :registration-id="r.id"
              :disabled="
                !canSave &&
                !(edit.editing.value && r.actions.editOwnMember && person.userId === auth.user?.id)
              "
            /><el-button
              v-if="
                edit.editing.value &&
                r.actions.editOwnMember &&
                !editor &&
                person.userId === auth.user?.id
              "
              type="primary"
              @click="memberSave(person.id!, index)"
              >保存我的信息</el-button
            >
          </div>
        </PaginatedList>
        <div
          class="actions"
          v-if="
            canSave && policy?.mode === 'TEAM' && form.people.length < (policy?.maxMembers ?? 0)
          "
        >
          <el-button v-if="policy?.memberMode === 'MANUAL'" @click="addPerson"
            >添加代填成员</el-button
          ><el-button v-else @click="invite('MEMBER')">生成成员邀请链接</el-button>
        </div>
        <div class="card" v-if="policy?.coachMode !== 'DISABLED'">
          <div class="member-heading">
            <h3>指导老师</h3>
            <el-button
              v-if="canSave && r.coaches.length < (policy?.maxCoaches ?? 0)"
              @click="invite('COACH')"
              >邀请老师确认</el-button
            >
          </div>
          <el-empty
            v-if="!r.coaches.length"
            :description="
              policy?.coachMode === 'REQUIRED' ? '请关联一位指导老师后提交' : '可以不关联指导老师'
            "
            :image-size="55"
          />
          <PaginatedList
            :items="form.coaches"
            page-key="registration-coaches"
            :always="false"
            v-slot="{ items }"
          >
            <div v-for="coach in items" :key="coach.id">
              <div class="member-heading">
                <span
                  >{{ coach.user?.name || coach.name || '指导老师' }} ·
                  {{ coach.user?.email }}</span
                ><el-button v-if="canSave" text type="danger" @click="removeCoach(coach.id)"
                  >解除关联</el-button
                >
              </div>
              <DynamicFields
                :fields="r.fields"
                scope="COACH"
                :answers="coach.answers"
                :prefix="coach.id"
                :registration-id="r.id"
                :disabled="!canSave"
              />
            </div>
          </PaginatedList>
          <p class="form-help">
            也可使用老师提供的关联链接。老师确认关联后可以代填和提交，解除后立即失去访问权限。
          </p>
        </div>
        <div v-if="link" class="card">
          <h3>邀请链接</h3>
          <div class="copy-link">
            <el-input :model-value="link" readonly /><el-button @click="copy">复制</el-button>
          </div>
          <p class="form-help">受邀者登录并确认后关联生效，有效期 7 天。</p>
        </div>
        <div v-if="canSave" class="actions">
          <el-button v-if="r.actions.submit" type="primary" :loading="busy" @click="submit"
            >提交报名</el-button
          >
          <el-button
            :type="r.actions.submit ? 'default' : 'primary'"
            :loading="busy"
            @click="save"
            >{{ savingDraft ? '保存草稿' : '保存修改' }}</el-button
          >
        </div>
      </el-form>
      <div class="toolbar">
        <el-button
          v-if="!edit.editing.value && r.actions.submit"
          type="primary"
          :loading="busy"
          @click="submit"
          >提交报名</el-button
        >
        <el-button
          v-if="!edit.editing.value && r.actions.withdraw"
          @click="action(`/registrations/${r.id}/withdraw`, { version: r.version })"
          >撤回为草稿</el-button
        >
        <el-button v-if="r.actions.review" type="primary" @click="openReview">审核报名</el-button>
        <el-button v-if="r.actions.amendReview" type="primary" @click="openReview"
          >修改审核</el-button
        >
        <el-button v-if="r.actions.cancel" type="danger" plain @click="cancel">取消报名</el-button>
        <el-button v-if="r.actions.delete" type="danger" @click="removeRegistration"
          >删除报名</el-button
        >
      </div>
      <div v-if="manager" class="card">
        <h3>公示排名</h3>
        <EditActions :session="rankEdit" /><template v-if="rankEdit.editing.value"
          ><el-input-number v-model="rank.rank" :min="1" aria-label="网络赛排名" /><el-button
            @click="saveRank"
            >保存排名</el-button
          ></template
        >
        <p v-else>{{ r.publicRank || '未设置排名' }}</p>
      </div>
      <RegistrationReview
        v-model="reviewOpen"
        :registration-id="r.id"
        @reviewed="refresh"
        @next="
          reviewOpen = false;
          refresh();
        "
      />
      <router-link :to="`/support?registrationId=${r.id}&contestId=${r.contestId}`"
        ><el-button text type="primary">对此报名提起工单</el-button></router-link
      >
    </div>
    <div class="panel" v-if="tab === 'finance'">
      <div class="stats">
        <div class="stat">
          <span>应付金额</span>
          <div class="value">{{ money(r.feeCents) }}</div>
        </div>
        <div class="stat">
          <span>净到账金额</span>
          <div class="value">{{ money(r.netPaidCents) }}</div>
        </div>
        <div class="stat">
          <span>已开票金额</span>
          <div class="value">{{ money(invoiceTotal) }}</div>
        </div>
        <div class="stat">
          <span>待付金额</span>
          <div class="value">{{ money(Math.max(0, r.feeCents - r.netPaidCents)) }}</div>
        </div>
      </div>
      <div class="notice" v-if="policy?.feeMode === 'FREE'">本竞赛免费，无需缴费。</div>
      <template v-else
        ><div class="card">
          <h3>线下缴费说明</h3>
          <p class="pre-line">
            {{ policy?.paymentInstructions || '请按照主办方公布的收款方式缴费。' }}
          </p>
          <p class="muted">
            {{
              policy?.paymentSequence === 'REVIEW_FIRST'
                ? '先审核通过，再上传凭证'
                : '先缴费并核账，再审核资料'
            }}。上传凭证后须等待管理员确认实际到账。
          </p>
          <div v-if="r.actions.requestFinance" class="actions">
            <el-button v-if="canUploadVoucher" type="primary" @click="voucherDialog = true"
              >上传收款凭证</el-button
            ><el-button
              v-if="policy?.refundsEnabled && r.netPaidCents > 0"
              @click="financialRequest('refunds')"
              >申请退款</el-button
            ><el-button
              v-if="invoicePolicy?.invoicesEnabled && r.netPaidCents > r.invoiceReservedCents"
              @click="financialRequest('invoices')"
              >申请开票</el-button
            >
          </div>
        </div></template
      >
      <div class="card">
        <h3>收款凭证</h3>
        <el-alert
          v-if="voucherPage.error.value"
          :title="voucherPage.error.value"
          type="error"
          :closable="false"
        />
        <div class="toolbar">
          <el-select
            v-model="voucherPage.filters.value.status"
            clearable
            placeholder="筛选状态"
            filterable
            ><el-option
              v-for="state in ['PENDING', 'CONFIRMED', 'REJECTED']"
              :key="state"
              :value="state"
              :label="label(state)" /></el-select
          ><el-date-picker
            v-model="voucherPage.filters.value.from"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="开始时间"
          /><el-date-picker
            v-model="voucherPage.filters.value.to"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="结束时间"
          />
        </div>
        <el-input
          v-model="voucherPage.filters.value.search"
          clearable
          placeholder="搜索付款人、渠道或参考号"
          style="max-width: 360px; margin-bottom: 16px"
        />
        <el-table :data="voucherPage.items.value"
          ><el-table-column label="付款人" prop="payer" /><el-table-column label="金额"
            ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
          ><el-table-column label="状态"
            ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
          ><el-table-column label="操作" min-width="180"
            ><template #default="{ row }"
              ><a :href="`/api/v1/files/${row.attachmentId}`" target="_blank">查看凭证</a
              ><template
                v-if="financeReviewer && !ownUser(row.createdBy ?? '') && row.status === 'PENDING'"
                ><el-button text type="primary" @click="confirmVoucher(row)">核账</el-button
                ><el-button text type="danger" @click="rejectVoucher(row.id)"
                  >拒绝</el-button
                ></template
              ><span v-if="row.reason"> {{ row.reason }}</span></template
            ></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="voucherPage.page.value"
          v-model:size="voucherPage.pageSize.value"
          :total="voucherPage.total.value"
          :loading="voucherPage.loading.value"
        />
      </div>
      <div class="card">
        <h3>账簿</h3>
        <el-alert
          v-if="ledgerPage.error.value"
          :title="ledgerPage.error.value"
          type="error"
          :closable="false"
        />
        <div class="toolbar">
          <el-select
            v-model="ledgerPage.filters.value.status"
            clearable
            placeholder="筛选状态"
            filterable
            ><el-option
              v-for="state in ['PAYMENT', 'REFUND', 'REVERSAL', 'RECEIVABLE']"
              :key="state"
              :value="state"
              :label="label(state)" /></el-select
          ><el-date-picker
            v-model="ledgerPage.filters.value.from"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="开始时间"
          /><el-date-picker
            v-model="ledgerPage.filters.value.to"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="结束时间"
          />
        </div>
        <el-input
          v-model="ledgerPage.filters.value.search"
          clearable
          placeholder="搜索账目说明或参考号"
          style="max-width: 360px; margin-bottom: 16px"
        />
        <el-table :data="ledgerPage.items.value"
          ><el-table-column label="时间" min-width="170"
            ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
          ><el-table-column label="类型"
            ><template #default="{ row }">{{
              ({ RECEIVABLE: '应收', PAYMENT: '收款', REFUND: '退款', REVERSAL: '冲正' } as Data)[
                row.kind
              ]
            }}</template></el-table-column
          ><el-table-column label="金额"
            ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
          ><el-table-column label="说明" prop="note" min-width="160" /><el-table-column
            v-if="financeReviewer"
            label="操作"
            ><template #default="{ row }"
              ><span v-if="row.reversed" class="muted">已冲正</span
              ><el-button
                v-else-if="row.kind === 'PAYMENT'"
                text
                type="danger"
                @click="reverse(row.id)"
                >冲正</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="ledgerPage.page.value"
          v-model:size="ledgerPage.pageSize.value"
          :total="ledgerPage.total.value"
          :loading="ledgerPage.loading.value"
        />
      </div>
      <div class="card">
        <h3>退款记录</h3>
        <el-alert
          v-if="refundPage.error.value"
          :title="refundPage.error.value"
          type="error"
          :closable="false"
        />
        <div class="toolbar">
          <el-select
            v-model="refundPage.filters.value.status"
            clearable
            placeholder="筛选状态"
            filterable
            ><el-option
              v-for="state in ['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED']"
              :key="state"
              :value="state"
              :label="label(state)" /></el-select
          ><el-date-picker
            v-model="refundPage.filters.value.from"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="开始时间"
          /><el-date-picker
            v-model="refundPage.filters.value.to"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="结束时间"
          />
        </div>
        <el-input
          v-model="refundPage.filters.value.search"
          clearable
          placeholder="搜索退款原因或参考号"
          style="max-width: 360px; margin-bottom: 16px"
        />
        <el-table :data="refundPage.items.value"
          ><el-table-column label="金额"
            ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
          ><el-table-column label="原因" prop="reason" min-width="150" /><el-table-column
            label="状态"
            ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
          ><el-table-column label="实际退款参考号" prop="reference" /><el-table-column
            v-if="financeReviewer"
            label="操作"
            min-width="180"
            ><template #default="{ row }"
              ><template v-if="row.status === 'REQUESTED'"
                ><el-button
                  text
                  @click="action(`/finance/refunds/${row.id}/review`, { decision: 'APPROVED' })"
                  >同意</el-button
                ><el-button
                  text
                  type="danger"
                  @click="action(`/finance/refunds/${row.id}/review`, { decision: 'REJECTED' })"
                  >拒绝</el-button
                ></template
              ><el-button
                v-if="row.status === 'APPROVED'"
                text
                type="primary"
                :disabled="
                  row.amountCents > r.feeCents && ownUser(row.approvedBy ?? row.handledBy ?? '')
                "
                title="超过应收费用的退款需要另一位财务管理员复核"
                @click="completeRefund(row.id)"
                >记录实际退款</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="refundPage.page.value"
          v-model:size="refundPage.pageSize.value"
          :total="refundPage.total.value"
          :loading="refundPage.loading.value"
        />
      </div>
      <div class="card">
        <h3>开票记录</h3>
        <el-alert
          v-if="invoicePage.error.value"
          :title="invoicePage.error.value"
          type="error"
          :closable="false"
        />
        <div class="toolbar">
          <el-select
            v-model="invoicePage.filters.value.status"
            clearable
            placeholder="筛选状态"
            filterable
            ><el-option
              v-for="state in ['REQUESTED', 'ISSUED', 'REJECTED', 'VOID']"
              :key="state"
              :value="state"
              :label="label(state)" /></el-select
          ><el-date-picker
            v-model="invoicePage.filters.value.from"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="开始时间"
          /><el-date-picker
            v-model="invoicePage.filters.value.to"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="结束时间"
          />
        </div>
        <el-input
          v-model="invoicePage.filters.value.search"
          clearable
          placeholder="搜索发票抬头、税号或备注"
          style="max-width: 360px; margin-bottom: 16px"
        />
        <el-table :data="invoicePage.items.value"
          ><el-table-column label="申请信息" min-width="190"
            ><template #default="{ row }"
              ><div>{{ row.title }}</div>
              <span class="muted">{{
                row.invoiceType === 'SPECIAL'
                  ? '专用发票'
                  : row.invoiceType === 'NORMAL'
                    ? '普通发票'
                    : '历史申请'
              }}</span
              ><el-button text type="primary" @click="invoiceDetail = row"
                >查看详情</el-button
              ></template
            ></el-table-column
          ><el-table-column label="抬头" prop="title" min-width="160" /><el-table-column
            label="金额"
            ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
          ><el-table-column label="状态"
            ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
          ><el-table-column label="操作" min-width="160"
            ><template #default="{ row }"
              ><a
                v-if="row.attachmentId"
                :href="`/api/v1/files/${row.attachmentId}`"
                target="_blank"
                >下载发票</a
              ><el-button
                v-if="financeManager && row.status === 'REQUESTED'"
                text
                type="primary"
                @click="openInvoice(row.id)"
                >上传发票</el-button
              ><el-button
                v-if="financeManager && row.status === 'ISSUED'"
                text
                type="danger"
                @click="
                  action(`/finance/invoices/${row.id}/review`, {
                    decision: 'VOID',
                    reason: '管理员作废',
                  })
                "
                >作废</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="invoicePage.page.value"
          v-model:size="invoicePage.pageSize.value"
          :total="invoicePage.total.value"
          :loading="invoicePage.loading.value"
        />
      </div>
    </div>
    <div v-if="tab === 'admissions' && r.contest.modules.admissions" class="panel">
      <div class="notice">
        {{
          policy?.mode === 'TEAM' ? '全队共用一张准考证' : '个人报名一人一张准考证'
        }}。资料或资格变更后，原准考证会失效。
      </div>
      <div v-if="admissionManager" class="actions">
        <el-button type="primary" :disabled="!r.eligible" @click="generate">{{
          r.contest.modules.rooms ? '按排考生成准考证' : '生成准考证'
        }}</el-button
        ><router-link
          v-if="r.contest.modules.rooms"
          :to="`/admin/contests/${r.contestId}?tab=rooms`"
          ><el-button>考场与座位</el-button></router-link
        ><router-link :to="`/admin/contests/${r.contestId}?tab=templates`"
          ><el-button>配置模板</el-button></router-link
        >
      </div>
      <div class="card">
        <PaginatedTable page-key="registration-r-admissions" :data="r.admissions"
          ><el-table-column label="准考证号" prop="number" min-width="220" /><el-table-column
            label="考场"
            prop="room"
          /><el-table-column label="座位" prop="seat" /><el-table-column label="状态"
            ><template #default="{ row }">{{ label(row.state) }}</template></el-table-column
          ><el-table-column label="操作" min-width="160"
            ><template #default="{ row }"
              ><el-button
                v-if="admissionManager && row.state === 'READY'"
                text
                type="primary"
                @click="action(`/admissions/${row.id}/release`)"
                >发放</el-button
              ><a
                v-if="row.state === 'RELEASED' || (admissionManager && row.state === 'READY')"
                :href="`/api/v1/admissions/${row.id}/download`"
                target="_blank"
                >下载 PDF</a
              ></template
            ></el-table-column
          ></PaginatedTable
        >
      </div>
    </div>
    <div v-if="tab === 'accounts' && r.contest.modules.integrations" class="panel">
      <div class="notice">比赛账号与本站账号分别管理。请妥善保存比赛账号。</div>
      <div v-if="integrationManager">
        <PaginatedList
          :items="bindings"
          page-key="registration-bindings"
          :always="false"
          v-slot="{ items }"
          ><div class="actions">
            <el-button
              v-for="b in items"
              :key="b.id"
              @click="action(`/integrations/registrations/${r.id}/sync`, { bindingId: b.id })"
              >同步比赛账号{{
                bindings.length > 1 ? `（评测平台 ${bindings.indexOf(b) + 1}）` : ''
              }}</el-button
            >
          </div></PaginatedList
        >
      </div>
      <div class="card">
        <PaginatedTable page-key="registration-r-mappings" :data="r.mappings"
          ><el-table-column label="账号" prop="username" min-width="200" /><el-table-column
            label="同步状态"
            ><template #default="{ row }">{{ label(row.state) }}</template></el-table-column
          ><el-table-column label="远端队伍" prop="remoteTeamId" /><el-table-column
            label="远端用户"
            prop="remoteUserId"
        /></PaginatedTable>
        <div class="actions">
          <el-button
            v-if="r.actions.credentials"
            type="primary"
            @click="
              api(`/integrations/registrations/${r.id}/credentials`).then((v) => (credentials = v))
            "
            >查看获授权的比赛账号</el-button
          >
        </div>
        <PaginatedList
          :items="credentials"
          page-key="registration-credentials"
          :always="false"
          v-slot="{ items }"
        >
          <div v-for="c in items" :key="c.id" class="notice">
            用户名：{{ c.username }}<br />密码：<code>{{ c.password }}</code>
          </div>
        </PaginatedList>
        <p v-if="r.mappings.some((m) => m.state === 'REVOKED_LOCALLY')" class="error-state">
          本站已撤销资格。当前平台不支持自动停用，管理员需要在评测系统中手动处理原账号。
        </p>
      </div>
    </div>
    <el-dialog
      v-model="invoiceApplication"
      title="申请开票"
      width="760px"
      destroy-on-close
      :before-close="closeInvoiceApplication"
      :close-on-click-modal="false"
      :close-on-press-escape="!invoiceApplicationForm?.busy"
      :show-close="!invoiceApplicationForm?.busy"
      ><InvoiceApplication
        v-if="r && invoicePolicy"
        ref="invoiceApplicationForm"
        :registration-id="r.id"
        :available-cents="Math.max(0, r.netPaidCents - r.invoiceReservedCents)"
        :policy="invoicePolicy"
        @submitted="
          invoiceApplication = false;
          refresh();
        "
    /></el-dialog>
    <el-dialog
      :model-value="!!invoiceDetail"
      @close="invoiceDetail = undefined"
      title="开票申请详情"
      width="720px"
      ><el-descriptions v-if="invoiceDetail" :column="1" border
        ><el-descriptions-item
          v-for="(title, key) in {
            title: '抬头',
            invoiceType: '票种',
            titleType: '抬头类型',
            taxId: '税号',
            email: '接收邮箱',
            contactName: '联系人',
            phone: '电话',
            address: '地址',
            bankName: '开户银行',
            bankAccount: '银行账号',
            remarks: '备注',
            reason: '处理意见',
          }"
          :key="key"
          :label="title"
          >{{
            key === 'titleType'
              ? ({ PERSON: '个人', ENTERPRISE: '企业', ORGANIZATION: '非企业单位' } as Data)[
                  invoiceDetail[key]
                ] || '历史申请'
              : label(invoiceDetail[key]) || '—'
          }}</el-descriptions-item
        ><el-descriptions-item label="金额">{{
          money(invoiceDetail.amountCents)
        }}</el-descriptions-item></el-descriptions
      ></el-dialog
    >
    <el-dialog v-model="voucherDialog" title="上传收款凭证" width="520px"
      ><el-form label-position="top"
        ><el-form-item label="申报金额（元）"
          ><el-input-number v-model="voucher.amount" :min="0.01" :precision="2" /></el-form-item
        ><el-form-item label="付款人"><el-input v-model="voucher.payer" /></el-form-item
        ><el-form-item label="渠道"><el-input v-model="voucher.channel" /></el-form-item
        ><el-form-item label="流水 / 参考号"><el-input v-model="voucher.reference" /></el-form-item
        ><el-form-item label="付款时间"
          ><el-date-picker
            v-model="voucher.paidAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item
        ><el-form-item label="凭证文件"
          ><input
            type="file"
            accept=".pdf,.png,.jpg"
            @change="attach($event, voucher)" /></el-form-item></el-form
      ><template #footer
        ><el-button
          type="primary"
          :loading="busy"
          :disabled="!voucher.attachmentId"
          @click="sendVoucher"
          >提交凭证</el-button
        ></template
      ></el-dialog
    >
    <el-dialog v-model="invoiceDialog" title="上传实际发票" width="450px" destroy-on-close
      ><input
        :key="selectedInvoice"
        type="file"
        accept=".pdf,.png,.jpg"
        @change="attach($event, invoiceFile)"
      /><template #footer
        ><el-button type="primary" :disabled="!invoiceFile.attachmentId" @click="issue"
          >确认上传</el-button
        ></template
      ></el-dialog
    >
  </template>
</template>
