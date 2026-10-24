<script setup lang="ts">
import PaginatedTable from '../components/PaginatedTable.vue';
import DeleteContestButton from '../components/DeleteContestButton.vue';
import PaginatedList from '../components/PaginatedList.vue';
import { ref, onMounted, watch, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, auth, date, label, loadAuth } from '../api';
import {
  defaultTemplate,
  accountInvitationLabels,
  type AccountInvitationInput,
} from '@contest-center/contracts';
import type { Data, ContestView } from '../types';
import { useEditSession, mayLeaveEdits } from '../composables/useEditSession';
import EditActions from '../components/EditActions.vue';
import MailSettings from '../components/MailSettings.vue';
import GithubSettings from '../components/GithubSettings.vue';
import FeishuSettings from '../components/FeishuSettings.vue';
import StorageSettings from '../components/StorageSettings.vue';
import MailTemplates from '../components/MailTemplates.vue';
import StudentsView from '../components/StudentsView.vue';
import UserDetail from '../components/UserDetail.vue';
import IdentityReviews from '../components/IdentityReviews.vue';
import AdminGrants from '../components/AdminGrants.vue';
import { isSystemAdmin, canManage } from '../permissions';
import ListPagination from '../components/ListPagination.vue';
import { usePagedList } from '../composables/usePagedList';
import { useRoute } from 'vue-router';
import { useRouter } from 'vue-router';
import { adminCenters, centerTabs } from '../admin-centers';
const route = useRoute();
const router = useRouter();
const center = adminCenters.find((item) => item.key === route.meta.adminCenter)!;
const tabs = computed(() => centerTabs(center.key, auth.user));
const allowedTabs = computed(() => tabs.value.map((item) => item.name));
const requestedTab = typeof route.query.tab === 'string' ? route.query.tab : allowedTabs.value[0]!;
const userDetailId = ref('');
const peopleView = ref<InstanceType<typeof StudentsView>>();
const jobsPage = usePagedList('jobs', () => '/admin/jobs'),
  contestsPage = usePagedList<ContestView>(
    'managed-contests',
    () => '/contests?all=true&managed=true',
  ),
  usersPage = usePagedList('users', () => '/admin/users'),
  logsPage = usePagedList('audit', () => '/admin/audit'),
  invitationsPage = usePagedList('invitations', () => '/admin/invitations');
const loadError = ref(''),
  detail = ref<Data>(),
  effectivePublicUrl = ref('');
const tagOptions = ref<string[]>([]),
  tagDialog = ref(false),
  taggedUser = ref<Data>({ tags: [] }),
  tagsBusy = ref(false);
async function editTags(row: Data) {
  taggedUser.value = { id: row.id, version: row.version, name: row.name, tags: [...row.tags] };
  tagDialog.value = true;
}
async function saveTags() {
  tagsBusy.value = true;
  try {
    await api(`/admin/users/${taggedUser.value.id}/tags`, 'PUT', taggedUser.value);
    tagDialog.value = false;
    await refresh();
    if (taggedUser.value.id === auth.user?.id) await loadAuth();
    ElMessage.success('用户标签已保存');
  } finally {
    tagsBusy.value = false;
  }
}
const operationNames: Record<string, string> = {
  ACCOUNT_REGISTER: '完成邮箱验证并注册',
  USER_PROFILE_UPDATE: '修改用户资料',
  ACCOUNT_BAN: '封禁账号',
  ACCOUNT_UNBAN: '解除账号封禁',
  ACCOUNT_DELETE: '删除账号',
  SITE_URL_RECOVERY: '命令行恢复公网地址',
  SITE_UPDATE: '修改全局设置',
  MAIL_SETTINGS_UPDATE: '修改邮件设置',
  MAIL_SETTINGS_TEST: '发送测试邮件',
  CONTEST_CREATE: '创建竞赛',
  CONTEST_UPDATE: '更新竞赛',
  CONTEST_DELETE: '删除活动及竞赛',
  REGISTRATION_CREATE: '创建报名',
  REGISTRATION_EDIT: '修改报名',
  REGISTRATION_SUBMIT: '提交报名',
  REVIEW: '审核报名',
  VOUCHER_UPLOAD: '上传缴费凭证',
  VOUCHER_REVIEW: '核对收款',
  PAYMENT_REVERSE: '收款冲正',
  REFUND_REQUEST: '申请退款',
  REFUND_REVIEW: '处理退款',
  INVOICE_REQUEST: '申请开票',
  INVOICE_REVIEW: '处理开票',
  TICKET_CREATE: '提交工单',
  TICKET_REPLY: '回复工单',
  CREDENTIAL_VIEW: '查看比赛账号',
  PLATFORM_EXPORT: '导出平台导入包',
  PLATFORM_BINDING_SAVE: '历史平台绑定',
  PLATFORM_BINDING_SYNC: '同步已有报名',
  ORGANIZATION_MAP_CONFIRM: '确认学校映射',
  AUTHORIZATION_INVITE_CREATE: '生成授权链接',
  AUTHORIZATION_INVITE_ACCEPT: '确认授权',
  AUTHORIZATION_INVITE_REVOKE: '撤销授权链接',
  ROLE_REVOKE: '撤销权限',
  MEMBER_INVITE: '邀请队员',
  MEMBER_REMOVE: '移除队员',
  COACH_REMOVE: '解除指导关系',
  INVITATION_ACCEPT: '确认报名邀请',
  CANCEL: '取消报名',
  ADMISSION_GENERATE: '生成准考证',
  ADMISSION_RELEASE: '发放准考证',
  TEMPLATE_SAVE: '保存准考证模板',
};
const tab = ref(allowedTabs.value.includes(requestedTab) ? requestedTab : allowedTabs.value[0]!),
  contests = ref<ContestView[]>([]),
  jobs = jobsPage.items,
  users = usersPage.items,
  logs = logsPage.items,
  site = ref<Data>({}),
  templates = ref<Data[]>([]),
  templateSource = ref(defaultTemplate),
  templateName = ref('全局准考证模板'),
  templateVersion = ref(0),
  fields = ref<Data[]>([]),
  metrics = ref<Data>({}),
  fieldDialog = ref(false),
  field = ref<Data>({}),
  fieldOptions = ref(''),
  authorizationDialog = ref(false),
  authorizationBusy = ref(false),
  authorization = ref<Partial<AccountInvitationInput>>({}),
  recipientMode = ref('account'),
  authorizationUrl = ref(''),
  authorizationExpiresAt = ref(''),
  authorizationInvitations = invitationsPage.items;
const invitationStates: Record<string, string> = {
  PENDING: '等待确认',
  ACCEPTED: '已确认',
  REVOKED: '已撤销',
  EXPIRED: '已过期',
};
const jobKinds: Record<string, string> = {
  MAIL: '邮件通知',
  ADMISSION: '准考证生成',
  ADMISSION_BATCH: '准考证批次',
  ACCOUNT_BACKFILL: '比赛账号生成',
  PDF_PREVIEW: '模板预览',
};
async function refresh() {
  loadError.value = '';
  try {
    if (['users', 'audit'].includes(tab.value)) contests.value = await api('/contests?all=true');
    if (tab.value === 'contests') await contestsPage.load();
    if (tab.value === 'jobs') {
      await jobsPage.load();
      if (auth.user?.isAdmin) metrics.value = await api('/admin/metrics');
    }
    if (tab.value === 'users')
      await Promise.all([
        usersPage.load(),
        invitationsPage.load(),
        api<string[]>('/admin/user-tags').then((tags) => (tagOptions.value = tags)),
      ]);
    if (tab.value === 'audit') await logsPage.load();
    if (tab.value === 'site') {
      const [settings, nextTemplates, nextFields] = await Promise.all([
        api('/admin/site'),
        api('/admissions/templates'),
        api('/admin/fields'),
      ]);
      templates.value = nextTemplates;
      fields.value = nextFields;
      effectivePublicUrl.value = settings.publicUrl;
      if (!siteEdit.editing.value) {
        site.value = settings;
        site.value.trustedOriginsInput = (site.value.trustedOrigins ?? []).join('\n');
      }
      const currentTemplate = templates.value.find((t) => t.active && !t.contestId);
      if (currentTemplate && !globalEdit.editing.value) {
        templateName.value = currentTemplate.name;
        templateSource.value = currentTemplate.source;
        templateVersion.value = currentTemplate.version;
      }
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '管理数据加载失败';
  }
}
async function reloadAll() {
  if (await mayLeaveEdits()) await refresh();
}
watch(tab, (value) => router.replace({ path: route.path, query: { ...route.query, tab: value } }));
onMounted(refresh);
onMounted(() => {
  if (route.query.tab !== undefined && route.query.tab !== tab.value)
    void router.replace({ path: route.path, query: { ...route.query, tab: tab.value } });
});
function inviteRole(kind: AccountInvitationInput['kind'] = 'ACCOUNT', user?: Data) {
  authorization.value = { kind, userId: user?.id, targetEmail: '', expiresInDays: 7 };
  recipientMode.value = user ? 'account' : 'email';
  authorizationUrl.value = '';
  authorizationExpiresAt.value = '';
  authorizationDialog.value = true;
}
async function generateAuthorization() {
  if (
    recipientMode.value === 'account'
      ? !authorization.value.userId
      : !authorization.value.targetEmail?.trim()
  ) {
    ElMessage.warning('请选择受邀账号或填写受邀邮箱');
    return;
  }
  if (authorization.value.kind === 'CONTEST_ADMIN' && !authorization.value.contestId) {
    ElMessage.warning('请选择要授权的竞赛');
    return;
  }
  authorizationBusy.value = true;
  try {
    const result = await api('/admin/invitations', 'POST', {
      kind: authorization.value.kind,
      ...(recipientMode.value === 'account'
        ? { userId: authorization.value.userId }
        : { targetEmail: authorization.value.targetEmail?.trim() }),
      ...(authorization.value.kind === 'CONTEST_ADMIN'
        ? { contestId: authorization.value.contestId }
        : {}),
      expiresInDays: authorization.value.expiresInDays,
      grantExpiresAt: authorization.value.grantExpiresAt || undefined,
      permissions: authorization.value.permissions,
    });
    authorizationUrl.value = result.url;
    authorizationExpiresAt.value = result.expiresAt;
    await refresh();
    ElMessage.success('邀请链接已生成，等待接收者确认');
  } finally {
    authorizationBusy.value = false;
  }
}
async function copyAuthorization() {
  try {
    await navigator.clipboard.writeText(authorizationUrl.value);
    ElMessage.success('邀请链接已复制');
  } catch {
    ElMessage.info('请在输入框中选中并复制邀请链接');
  }
}
async function revokeRole(row: Data, kind: AccountInvitationInput['kind'], contestId?: string) {
  const payload =
    kind === 'CONTEST_ADMIN'
      ? { contestId, grant: false }
      : kind === 'COACH_ROLE'
        ? { isCoach: false }
        : { isAdmin: false };
  await api('/admin/roles', 'POST', { userId: row.id, ...payload });
  await refresh();
  ElMessage.success('权限已撤销，对应未确认邀请同时失效');
}
async function revokeInvitation(id: string) {
  await api(`/invitations/${id}`, 'DELETE');
  await refresh();
  ElMessage.success('邀请链接已撤销');
}
function contestName(id: string) {
  return contests.value.find((c) => c.id === id)?.title ?? id.slice(0, 8);
}
const fieldEdit = useEditSession(field);
watch(fieldDialog, (open) => {
  if (open) fieldEdit.begin();
  else fieldEdit.finish();
});
async function closeField(done: () => void) {
  if (await fieldEdit.mayLeave()) done();
}
const siteEdit = useEditSession(site);
const globalTemplateModel = computed({
  get: () => ({
    name: templateName.value,
    source: templateSource.value,
    version: templateVersion.value,
  }),
  set: (value) => {
    templateName.value = value.name;
    templateSource.value = value.source;
    templateVersion.value = value.version;
  },
});
const globalEdit = useEditSession(globalTemplateModel);
async function saveGlobalTemplate() {
  await api('/admissions/templates', 'POST', globalTemplateModel.value);
  globalEdit.finish();
  await refresh();
}
async function saveSite() {
  const { trustedOriginsInput, ...settings } = site.value;
  await api('/admin/site', 'PUT', {
    ...settings,
    trustedOrigins: String(trustedOriginsInput ?? '')
      .split(/[\n,，]+/)
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  siteEdit.finish();
  ElMessage.success('站点配置已保存');
  await refresh();
}
function editGlobalField(f?: Data) {
  field.value = f
    ? { ...JSON.parse(JSON.stringify(f.definition)), version: f.version }
    : {
        key: '',
        label: '',
        scope: 'PERSON',
        type: 'text',
        required: false,
        sensitive: false,
        options: [],
        help: '',
        group: '基本信息',
      };
  fieldOptions.value = field.value.options.join('\n');
  fieldDialog.value = true;
}
async function saveGlobalField() {
  await api('/admin/fields', 'POST', {
    ...field.value,
    options: fieldOptions.value.split('\n').filter(Boolean),
  });
  fieldDialog.value = false;
  await refresh();
}
</script>
<template>
  <el-dialog v-model="tagDialog" :title="`编辑 ${taggedUser.name || ''} 的标签`" width="520px">
    <el-select
      v-model="taggedUser.tags"
      multiple
      filterable
      allow-create
      default-first-option
      placeholder="输入标签后回车，最多 20 个"
      aria-label="用户标签"
      style="width: 100%"
      ><el-option v-for="tag in tagOptions" :key="tag" :value="tag" :label="tag"
    /></el-select>
    <template #footer
      ><el-button @click="tagDialog = false">取消</el-button
      ><el-button type="primary" :loading="tagsBusy" @click="saveTags"
        >保存标签</el-button
      ></template
    >
  </el-dialog>
  <div class="page-heading">
    <div>
      <h1>{{ center.label }}</h1>
      <p class="subtitle">{{ center.description }}</p>
    </div>
    <el-button @click="['students', 'teachers'].includes(tab) ? peopleView?.refresh() : refresh()"
      >刷新</el-button
    >
  </div>
  <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false"
    ><el-button text @click="reloadAll">重新加载</el-button></el-alert
  >
  <el-tabs v-model="tab" :before-leave="mayLeaveEdits">
    <el-tab-pane v-for="item in tabs" :key="item.name" :label="item.label" :name="item.name" />
  </el-tabs>
  <div class="panel" v-if="tab === 'mail' && isSystemAdmin()"><MailSettings /></div>
  <div class="panel" v-if="tab === 'github' && isSystemAdmin()"><GithubSettings /></div>
  <div class="panel" v-if="tab === 'feishu' && isSystemAdmin()"><FeishuSettings /></div>
  <StorageSettings v-if="tab === 'storage' && isSystemAdmin()" />
  <MailTemplates v-if="tab === 'mail-templates' && isSystemAdmin()" />
  <StudentsView v-if="tab === 'students' && allowedTabs.includes('students')" ref="peopleView" />
  <StudentsView
    v-if="tab === 'teachers' && allowedTabs.includes('teachers')"
    ref="peopleView"
    kind="TEACHER"
  />
  <UserDetail :id="userDetailId" @close="userDetailId = ''" @changed="refresh" />
  <IdentityReviews v-if="tab === 'identities' && auth.user?.isAdmin" />
  <AdminGrants v-if="tab === 'grants' && auth.user?.isAdmin" />
  <div class="panel" v-if="tab === 'contests'">
    <div class="toolbar">
      <el-input
        v-model="contestsPage.filters.value.search"
        placeholder="搜索活动或赛季"
        clearable
        style="max-width: 360px"
      />
    </div>
    <div class="actions" v-if="auth.user?.isAdmin">
      <router-link to="/admin/contests/new"
        ><el-button type="primary">创建竞赛</el-button></router-link
      >
    </div>
    <div class="card">
      <p class="form-help">
        报名人数按当前已提交报名的参加人数统计，团队按成员人数计，不含草稿、已撤回或已删除报名。
      </p>
      <el-alert
        v-if="contestsPage.error.value"
        :title="contestsPage.error.value"
        type="error"
        :closable="false"
      />
      <el-table :data="contestsPage.items.value" v-loading="contestsPage.loading.value"
        ><el-table-column label="竞赛名称" prop="title" min-width="280" /><el-table-column
          label="赛季"
          prop="season"
          width="100" /><el-table-column label="公开" width="90"
          ><template #default="{ row }">{{
            row.published ? '已发布' : '草稿'
          }}</template></el-table-column
        ><el-table-column label="模式" width="100"
          ><template #default="{ row }">{{
            row.policy.mode === 'TEAM' ? '团队' : '个人'
          }}</template></el-table-column
        ><el-table-column label="报名人数" min-width="160"
          ><template #default="{ row }"
            ><div>正式 {{ row.registrationCounts?.official ?? 0 }} 人</div>
            <div class="muted">
              非正式 {{ row.registrationCounts?.unofficial ?? 0 }} 人
            </div></template
          ></el-table-column
        ><el-table-column label="操作" width="250"
          ><template #default="{ row }"
            ><div class="table-actions contest-list-actions">
              <router-link :to="`/admin/contests/${row.id}`">编辑配置</router-link>
              <router-link :to="`/admin/contests/${row.id}?tab=registrations`"
                >报名管理</router-link
              >
              <DeleteContestButton
                :contest="row"
                text
                @deleted="contestsPage.load"
              /></div></template></el-table-column
      ></el-table>
      <ListPagination
        v-model:page="contestsPage.page.value"
        v-model:size="contestsPage.pageSize.value"
        :total="contestsPage.total.value"
        :loading="contestsPage.loading.value"
      />
    </div>
  </div>
  <div class="panel" v-if="tab === 'jobs'">
    <div class="stats" v-if="auth.user?.isAdmin">
      <div class="stat">
        <span>后台任务服务</span>
        <div class="value">{{ metrics.workerHealthy ? '运行中' : '暂未响应' }}</div>
      </div>
      <div class="stat">
        <span>待派发事件</span>
        <div class="value">{{ metrics.outboxPending }}</div>
      </div>
      <div class="stat">
        <span>等待任务</span>
        <div class="value">{{ (metrics.jobs?.PENDING || 0) + (metrics.jobs?.OUTBOX || 0) }}</div>
      </div>
      <div class="stat">
        <span>失败任务</span>
        <div class="value">{{ metrics.jobs?.FAILED || 0 }}</div>
      </div>
    </div>
    <div class="card">
      <h3>持久化任务</h3>
      <div class="toolbar">
        <el-input
          v-model="jobsPage.filters.value.search"
          clearable
          placeholder="搜索持久化任务"
          aria-label="搜索持久化任务"
          style="max-width: 280px"
        /><el-select
          v-model="jobsPage.filters.value.status"
          clearable
          placeholder="筛选状态／操作"
          style="max-width: 240px"
          filterable
          ><el-option
            v-for="state in ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED']"
            :key="state"
            :value="state"
            :label="label(state)"
        /></el-select>
      </div>
      <div class="toolbar">
        <el-date-picker
          v-model="jobsPage.filters.value.from"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ"
          placeholder="开始时间"
        /><el-date-picker
          v-model="jobsPage.filters.value.to"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ"
          placeholder="结束时间"
        />
      </div>
      <el-alert
        v-if="jobsPage.error.value"
        :title="jobsPage.error.value"
        type="error"
        :closable="false"
      /><el-table :data="jobs"
        ><el-table-column label="类型" width="130"
          ><template #default="{ row }">{{
            jobKinds[row.kind] ?? '后台任务'
          }}</template></el-table-column
        ><el-table-column label="状态" width="100"
          ><template #default="{ row }">{{ label(row.state) }}</template></el-table-column
        ><el-table-column label="尝试" prop="attempts" width="70" /><el-table-column
          label="说明"
          min-width="220"
          ><template #default="{ row }"
            ><span>{{ row.error ? '执行失败，请查看详情' : '—' }}</span
            ><el-button text type="primary" @click="detail = row">详情</el-button></template
          ></el-table-column
        ><el-table-column label="更新时间" min-width="180"
          ><template #default="{ row }">{{ date(row.updatedAt) }}</template></el-table-column
        ><el-table-column label="操作" width="90"
          ><template #default="{ row }"
            ><el-button
              v-if="row.canRetry"
              text
              type="primary"
              @click="
                api(`/admin/jobs/${row.id}/retry`, 'POST')
                  .then(refresh)
                  .catch(() => undefined)
              "
              >重试</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <ListPagination
        v-model:page="jobsPage.page.value"
        v-model:size="jobsPage.pageSize.value"
        :total="jobsPage.total.value"
        :loading="jobsPage.loading.value"
      />
    </div>
  </div>
  <div class="panel" v-if="tab === 'users'">
    <div class="actions">
      <el-button type="primary" @click="inviteRole()">生成邀请链接</el-button>
    </div>
    <div class="notice">
      公开邮箱注册保持开放。账号邀请及新增身份权限通过链接确认；生成或打开链接不会授予权限，接收者验证邮箱并确认后才会生效。
    </div>
    <div class="card">
      <div class="toolbar">
        <el-input
          v-model="usersPage.filters.value.search"
          clearable
          placeholder="搜索用户"
          aria-label="搜索用户"
          style="max-width: 280px"
        />
        <el-select
          v-model="usersPage.filters.value.tag"
          clearable
          filterable
          placeholder="筛选用户标签"
          aria-label="筛选用户标签"
          ><el-option v-for="tag in tagOptions" :key="tag" :value="tag" :label="tag"
        /></el-select>
      </div>
      <el-alert
        v-if="usersPage.error.value"
        :title="usersPage.error.value"
        type="error"
        :closable="false"
      /><el-table :data="users"
        ><el-table-column label="姓名" prop="name" /><el-table-column
          label="用户标签"
          min-width="170"
          ><template #default="{ row }"
            ><el-tag v-for="tag in row.tags" :key="tag" style="margin: 2px">{{
              tag
            }}</el-tag></template
          ></el-table-column
        ><el-table-column label="邮箱" prop="email" min-width="200" /><el-table-column
          label="账号状态"
          width="100"
          ><template #default="{ row }"
            ><el-tag :type="row.bannedAt ? 'danger' : 'success'">{{
              row.bannedAt ? '已封禁' : '正常'
            }}</el-tag></template
          ></el-table-column
        ><el-table-column label="身份" min-width="200"
          ><template #default="{ row }"
            ><el-tag type="info">{{ row.kind === 'TEACHER' ? '教师' : '学生' }}</el-tag
            ><el-tag v-if="row.isAdmin">{{
              row.isSystemAdmin ? '系统管理员' : '高级管理员'
            }}</el-tag
            ><el-tag v-if="row.isCoach" type="success">指导老师</el-tag
            ><el-tag v-for="role in row.roles" :key="role.contestId"
              >竞赛管理员 · {{ contestName(role.contestId) }}</el-tag
            ></template
          ></el-table-column
        ><el-table-column label="操作" min-width="340"
          ><template #default="{ row }"
            ><el-button text type="primary" @click="userDetailId = row.id">查看详情</el-button
            ><el-button text type="primary" @click="editTags(row)">编辑标签</el-button
            ><el-button text type="primary" @click="inviteRole('CONTEST_ADMIN', row)"
              >授权竞赛</el-button
            ><el-button
              v-if="isSystemAdmin() && row.id !== auth.user?.id"
              text
              :type="row.isSystemAdmin ? 'danger' : 'primary'"
              @click="
                row.isSystemAdmin
                  ? revokeRole(row, 'SYSTEM_ADMIN')
                  : inviteRole('SYSTEM_ADMIN', row)
              "
              >{{ row.isSystemAdmin ? '取消系统管理员' : '邀请系统管理员' }}</el-button
            ><el-button
              text
              :type="row.isCoach ? 'danger' : 'primary'"
              @click="row.isCoach ? revokeRole(row, 'COACH_ROLE') : inviteRole('COACH_ROLE', row)"
              >{{ row.isCoach ? '撤销指导老师' : '邀请指导老师' }}</el-button
            ><el-button
              v-for="role in row.roles"
              :key="role.contestId"
              text
              type="danger"
              @click="revokeRole(row, 'CONTEST_ADMIN', role.contestId)"
              >撤销 {{ contestName(role.contestId) }}</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <ListPagination
        v-model:page="usersPage.page.value"
        v-model:size="usersPage.pageSize.value"
        :total="usersPage.total.value"
        :loading="usersPage.loading.value"
      />
    </div>
    <div class="card">
      <h3>账号与授权邀请</h3>
      <p class="subtitle">链接仅在生成时展示，请及时复制。撤销等待确认的邀请，可立即让链接失效。</p>
      <div class="toolbar">
        <el-input
          v-model="invitationsPage.filters.value.search"
          clearable
          placeholder="搜索邀请"
          aria-label="搜索邀请"
          style="max-width: 280px"
        /><el-select
          v-model="invitationsPage.filters.value.status"
          clearable
          placeholder="筛选状态／操作"
          style="max-width: 240px"
          filterable
          ><el-option
            v-for="state in ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']"
            :key="state"
            :value="state"
            :label="invitationStates[state]"
        /></el-select>
      </div>
      <el-alert
        v-if="invitationsPage.error.value"
        :title="invitationsPage.error.value"
        type="error"
        :closable="false"
      /><el-table :data="authorizationInvitations" empty-text="暂无账号或授权邀请">
        <el-table-column label="邀请类型" min-width="120"
          ><template #default="{ row }">{{
            accountInvitationLabels[row.kind as AccountInvitationInput['kind']]
          }}</template></el-table-column
        >
        <el-table-column label="受邀账号 / 邮箱" min-width="230"
          ><template #default="{ row }"
            ><div>{{ row.target?.name ?? row.acceptedBy?.name ?? '待注册账号' }}</div>
            <span class="muted">{{ row.targetEmail }}</span></template
          ></el-table-column
        >
        <el-table-column label="权限范围" min-width="210"
          ><template #default="{ row }">{{
            row.contest?.title ??
            (row.kind === 'SYSTEM_ADMIN'
              ? '全站'
              : row.kind === 'COACH_ROLE'
                ? '经确认关联的报名'
                : '账号注册')
          }}</template></el-table-column
        >
        <el-table-column label="到期时间" min-width="180"
          ><template #default="{ row }">{{ date(row.expiresAt) }}</template></el-table-column
        >
        <el-table-column label="状态" width="110"
          ><template #default="{ row }"
            ><el-tag
              :type="
                row.state === 'ACCEPTED' ? 'success' : row.state === 'PENDING' ? 'warning' : 'info'
              "
              >{{ invitationStates[row.state] }}</el-tag
            ></template
          ></el-table-column
        >
        <el-table-column label="操作" width="110"
          ><template #default="{ row }"
            ><el-button
              v-if="row.state === 'PENDING'"
              text
              type="danger"
              @click="revokeInvitation(row.id)"
              >撤销邀请</el-button
            ></template
          ></el-table-column
        >
      </el-table>
      <ListPagination
        v-model:page="invitationsPage.page.value"
        v-model:size="invitationsPage.pageSize.value"
        :total="invitationsPage.total.value"
        :loading="invitationsPage.loading.value"
      />
    </div>
  </div>
  <div class="panel" v-if="tab === 'site'">
    <div class="card">
      <h3>站点设置</h3>
      <EditActions :session="siteEdit" />
      <el-form
        :key="String(siteEdit.editing.value)"
        label-position="top"
        :disabled="!siteEdit.editing.value"
        :class="{ 'read-mode': !siteEdit.editing.value }"
        ><el-form-item label="站点名称"><el-input v-model="site.name" /></el-form-item
        ><el-form-item label="主色"><el-color-picker v-model="site.primaryColor" /></el-form-item
        ><el-form-item label="页脚"><el-input v-model="site.footer" /></el-form-item
        ><el-form-item label="公网地址" for="site-public-url"
          ><el-input
            id="site-public-url"
            v-model="site.publicUrl"
            placeholder="https://reg.example.org"
        /></el-form-item>
        <el-form-item label="信任的请求来源" for="site-trusted-origins">
          <el-input
            id="site-trusted-origins"
            v-model="site.trustedOriginsInput"
            type="textarea"
            :rows="4"
            placeholder="https://reg.example.org&#10;http://192.168.1.10:8080"
          />
          <p class="form-help">
            可填写多个内网或外网入口，每行一个，也可用逗号分隔。须包含 HTTP／HTTPS
            和端口（如有），仅填写根地址。保存后立即生效。
          </p>
        </el-form-item>
        <div class="notice">
          <strong>当前生效地址：{{ effectivePublicUrl }}</strong>
          <p>验证邮箱、找回密码与邀请链接使用公网地址。同源入口及环境配置的信任来源自动允许。</p>
          <p v-if="site.environmentTrustedOrigins?.length" class="break-anywhere">
            环境配置的信任来源：{{ site.environmentTrustedOrigins.join('、') }}
          </p>
          <p class="break-anywhere">链接预览：{{ site.publicUrl }}/invite/示例邀请</p>
        </div>
        <el-button v-if="siteEdit.editing.value" type="primary" @click="saveSite"
          >保存</el-button
        ></el-form
      >
    </div>
    <div class="card">
      <h3>全局准考证模板</h3>
      <EditActions :session="globalEdit" />
      <el-input
        :disabled="!globalEdit.editing.value"
        v-model="templateName"
        style="margin-bottom: 15px"
      /><el-input
        v-model="templateSource"
        :disabled="!globalEdit.editing.value"
        type="textarea"
        :rows="16"
        class="monospace"
      />
      <div class="actions">
        <el-button v-if="globalEdit.editing.value" type="primary" @click="saveGlobalTemplate"
          >保存新版本</el-button
        >
      </div>
      <PaginatedList
        :items="templates"
        page-key="global-template-versions"
        :always="false"
        v-slot="{ items }"
      >
        <div v-for="t in items" :key="t.id" class="template-version">
          {{ t.name }} v{{ t.version }} <el-tag v-if="t.active">当前</el-tag
          ><el-button
            text
            @click="
              globalEdit.begin();
              templateSource = t.source;
              templateName = t.name;
            "
            >载入</el-button
          >
        </div>
      </PaginatedList>
    </div>
    <div class="card">
      <h3>全局字段库</h3>
      <el-button type="primary" @click="editGlobalField()">添加全局字段</el-button>
      <p class="muted">竞赛可从字段库导入，并独立调整要求。</p>
      <PaginatedTable page-key="admin-fields" :data="fields"
        ><el-table-column label="键名" prop="key" /><el-table-column label="名称"
          ><template #default="{ row }">{{ row.definition.label }}</template></el-table-column
        ><el-table-column label="作用域"
          ><template #default="{ row }">{{ row.definition.scope }}</template></el-table-column
        ></PaginatedTable
      >
    </div>
  </div>
  <div class="panel" v-if="tab === 'audit'">
    <div class="card">
      <div class="toolbar">
        <el-input
          v-model="logsPage.filters.value.search"
          clearable
          placeholder="搜索日志"
          aria-label="搜索日志"
          style="max-width: 280px"
        /><el-select
          v-model="logsPage.filters.value.status"
          clearable
          placeholder="筛选状态／操作"
          style="max-width: 240px"
          filterable
          ><el-option
            v-for="state in Object.keys(operationNames)"
            :key="state"
            :value="state"
            :label="operationNames[state]"
        /></el-select>
      </div>
      <div class="toolbar">
        <el-date-picker
          v-model="logsPage.filters.value.from"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ"
          placeholder="开始时间"
        /><el-date-picker
          v-model="logsPage.filters.value.to"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ"
          placeholder="结束时间"
        />
      </div>
      <el-alert
        v-if="logsPage.error.value"
        :title="logsPage.error.value"
        type="error"
        :closable="false"
      /><el-table :data="logs"
        ><el-table-column label="操作" min-width="180"
          ><template #default="{ row }">{{
            operationNames[row.action] ?? '系统操作'
          }}</template></el-table-column
        ><el-table-column label="关联对象" min-width="240"
          ><template #default="{ row }"
            >{{ row.resourceName || contestName(row.resourceId)
            }}<el-button text type="primary" @click="detail = row">详情</el-button></template
          ></el-table-column
        ><el-table-column label="操作人" prop="actorName" min-width="130" /><el-table-column
          label="时间"
          min-width="180"
          ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
        ></el-table
      >
      <ListPagination
        v-model:page="logsPage.page.value"
        v-model:size="logsPage.pageSize.value"
        :total="logsPage.total.value"
        :loading="logsPage.loading.value"
      />
    </div>
  </div>
  <el-dialog :model-value="!!detail" @close="detail = undefined" title="记录详情" width="720px">
    <pre class="record-detail">{{ JSON.stringify(detail, null, 2) }}</pre>
  </el-dialog>
  <el-dialog
    v-model="authorizationDialog"
    title="生成账号 / 授权邀请"
    width="580px"
    :close-on-click-modal="false"
  >
    <template v-if="authorizationUrl">
      <div class="notice">链接已生成，权限尚未生效。请将链接交给指定接收者，由其登录并确认。</div>
      <p>邀请类型：{{ accountInvitationLabels[authorization.kind!] }}</p>
      <p>有效期至：{{ date(authorizationExpiresAt) }}</p>
      <el-input
        :model-value="authorizationUrl"
        readonly
        aria-label="邀请链接"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <el-button type="primary" @click="copyAuthorization" style="margin-top: 16px"
        >复制邀请链接</el-button
      >
    </template>
    <el-form v-else label-position="top" @submit.prevent="generateAuthorization">
      <el-form-item label="邀请类型" for="authorization-kind"
        ><el-select
          id="authorization-kind"
          v-model="authorization.kind"
          style="width: 100%"
          filterable
          ><el-option
            v-for="(value, kind) in Object.fromEntries(
              Object.entries(accountInvitationLabels).filter(
                ([k]) => isSystemAdmin() || !['SYSTEM_ADMIN', 'SENIOR_ADMIN'].includes(k),
              ),
            )"
            :key="kind"
            :label="value"
            :value="kind" /></el-select
      ></el-form-item>
      <el-form-item label="接收者"
        ><el-radio-group v-model="recipientMode" aria-label="接收者类型"
          ><el-radio-button value="email">指定邮箱</el-radio-button
          ><el-radio-button value="account">已有账号</el-radio-button></el-radio-group
        ></el-form-item
      >
      <el-form-item v-if="recipientMode === 'account'" label="受邀账号" for="authorization-user"
        ><el-select
          id="authorization-user"
          v-model="authorization.userId"
          filterable
          style="width: 100%"
          ><el-option
            v-for="user in users"
            :key="user.id"
            :label="`${user.name} · ${user.email}`"
            :value="user.id" /></el-select
      ></el-form-item>
      <el-form-item v-else label="受邀邮箱" for="authorization-email"
        ><el-input
          id="authorization-email"
          v-model="authorization.targetEmail"
          type="email"
          placeholder="接收者使用此邮箱注册或登录"
      /></el-form-item>
      <el-form-item
        v-if="authorization.kind === 'CONTEST_ADMIN'"
        label="授权竞赛"
        for="authorization-contest"
        ><el-select
          id="authorization-contest"
          v-model="authorization.contestId"
          filterable
          style="width: 100%"
          ><el-option v-for="c in contests" :key="c.id" :label="c.title" :value="c.id" /></el-select
      ></el-form-item>
      <el-form-item label="有效天数（1–30 天）" for="authorization-days"
        ><el-input-number
          id="authorization-days"
          v-model="authorization.expiresInDays"
          :min="1"
          :max="30"
      /></el-form-item>
      <el-form-item
        v-if="['SYSTEM_ADMIN', 'SENIOR_ADMIN', 'CONTEST_ADMIN'].includes(authorization.kind || '')"
        label="授权到期时间（留空为永久）"
        ><el-date-picker
          v-model="authorization.grantExpiresAt"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ"
      /></el-form-item>
      <p class="muted">
        邀请仅限指定账号或邮箱接受。新增身份须由接收者确认，账号邀请不会附加管理员权限。
      </p>
    </el-form>
    <template #footer
      ><el-button @click="authorizationDialog = false">关闭</el-button
      ><el-button
        v-if="!authorizationUrl"
        type="primary"
        :loading="authorizationBusy"
        @click="generateAuthorization"
        >生成链接</el-button
      ></template
    >
  </el-dialog>
  <el-dialog :before-close="closeField" v-model="fieldDialog" title="全局字段" width="560px"
    ><el-form label-position="top"
      ><el-form-item label="键名"><el-input v-model="field.key" /></el-form-item
      ><el-form-item label="字段名称"><el-input v-model="field.label" /></el-form-item
      ><el-form-item label="作用域"
        ><el-select v-model="field.scope" filterable
          ><el-option
            v-for="k in ['PERSON', 'TEAM', 'COACH', 'REGISTRATION']"
            :key="k"
            :value="k"
            :label="label(k)" /></el-select></el-form-item
      ><el-form-item label="类型"
        ><el-select v-model="field.type" filterable
          ><el-option
            v-for="k in [
              'text',
              'textarea',
              'number',
              'date',
              'select',
              'multiselect',
              'boolean',
              'file',
              'photo',
            ]"
            :key="k"
            :value="k"
            :label="label(k)" /></el-select></el-form-item
      ><el-form-item label="选项（每行一个）" v-if="['select', 'multiselect'].includes(field.type)"
        ><el-input type="textarea" v-model="fieldOptions" /></el-form-item
      ><el-switch v-model="field.required" active-text="必填" /><el-switch
        v-model="field.sensitive"
        active-text="敏感字段"
        style="margin-left: 20px" /><el-form-item label="帮助文字"
        ><el-input v-model="field.help" /></el-form-item></el-form
    ><template #footer
      ><el-button type="primary" @click="saveGlobalField">保存字段</el-button></template
    ></el-dialog
  >
</template>
