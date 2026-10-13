<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, auth, date, label, loadAuth } from '../api';
import {
  defaultTemplate,
  accountInvitationLabels,
  type AccountInvitationInput,
} from '@contest-center/contracts';
import type { Data, ContestView } from '../types';
import PlatformBindings from '../components/PlatformBindings.vue';
import MailSettings from '../components/MailSettings.vue';
import GithubSettings from '../components/GithubSettings.vue';
import ListPagination from '../components/ListPagination.vue';
import { usePagedList } from '../composables/usePagedList';
import { useRoute } from 'vue-router';
const route = useRoute();
const requestedTab = typeof route.query.tab === 'string' ? route.query.tab : 'contests';
const allowedTabs = [
  'contests',
  'jobs',
  'instances',
  ...(auth.user?.isAdmin ? ['users', 'tokens', 'site', 'mail', 'github', 'audit'] : []),
];
const jobsPage = usePagedList('jobs', () => '/admin/jobs'),
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
  SITE_URL_RECOVERY: '命令行恢复公网地址',
  SITE_UPDATE: '修改全局设置',
  MAIL_SETTINGS_UPDATE: '修改邮件设置',
  MAIL_SETTINGS_TEST: '发送测试邮件',
  CONTEST_CREATE: '创建竞赛',
  CONTEST_UPDATE: '更新竞赛',
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
  PLATFORM_BINDING_SAVE: '保存平台绑定',
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
const tab = ref(allowedTabs.includes(requestedTab) ? requestedTab : 'contests'),
  contests = ref<ContestView[]>([]),
  jobs = jobsPage.items,
  users = usersPage.items,
  tokens = ref<Data[]>([]),
  instances = ref<Data[]>([]),
  logs = logsPage.items,
  site = ref<Data>({}),
  instanceDialog = ref(false),
  tokenDialog = ref(false),
  secret = ref(''),
  instance = ref<Data>({}),
  token = ref<Data>({}),
  templates = ref<Data[]>([]),
  templateSource = ref(defaultTemplate),
  templateName = ref('全局准考证模板'),
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
  SYNC: '比赛账号同步',
  ADMISSION: '准考证生成',
  PDF_PREVIEW: '模板预览',
  WEBHOOK: '事件推送',
};
async function refresh() {
  loadError.value = '';
  try {
    if (['contests', 'instances', 'users', 'tokens', 'audit'].includes(tab.value))
      contests.value = await api('/contests?all=true');
    if (tab.value === 'jobs') {
      await jobsPage.load();
      if (auth.user?.isAdmin) metrics.value = await api('/admin/metrics');
    }
    if (tab.value === 'instances') instances.value = await api('/integrations/instances');
    if (tab.value === 'users')
      await Promise.all([
        usersPage.load(),
        invitationsPage.load(),
        api<string[]>('/admin/user-tags').then((tags) => (tagOptions.value = tags)),
      ]);
    if (tab.value === 'audit') await logsPage.load();
    if (tab.value === 'tokens') tokens.value = await api('/admin/tokens');
    if (tab.value === 'site') {
      [site.value, templates.value, fields.value] = await Promise.all([
        api('/site'),
        api('/admissions/templates'),
        api('/admin/fields'),
      ]);
      effectivePublicUrl.value = site.value.publicUrl;
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '管理数据加载失败';
  }
}
watch(tab, refresh);
const managedContests = () =>
  contests.value.filter((c) => auth.user?.isAdmin || auth.user?.contestIds.includes(c.id));
onMounted(refresh);
function editInstance(i?: Data) {
  instance.value = i
    ? { ...i, credentials: {} }
    : {
        name: '',
        type: 'HYDRO',
        baseUrl: '',
        enabled: true,
        credentials: {},
        allowedContestIds: [],
      };
  instanceDialog.value = true;
}
async function saveInstance() {
  await api(
    instance.value.id ? `/integrations/instances/${instance.value.id}` : '/integrations/instances',
    instance.value.id ? 'PUT' : 'POST',
    instance.value,
  );
  instanceDialog.value = false;
  ElMessage.success('评测平台配置已保存');
  await refresh();
}
function newToken() {
  token.value = {
    name: '',
    contestIds: [],
    scopes: ['contests:read', 'registrations:read', 'finance:read', 'support:read'],
    fields: ['PERSON.name'],
    expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
  };
  tokenDialog.value = true;
}
async function createToken() {
  const x = await api('/admin/tokens', 'POST', token.value);
  secret.value = x.token;
  tokenDialog.value = false;
  await refresh();
}
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
async function saveSite() {
  await api('/admin/site', 'PUT', site.value);
  ElMessage.success('站点配置已保存');
  await refresh();
}
function editGlobalField(f?: Data) {
  field.value = f
    ? JSON.parse(JSON.stringify(f.definition))
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
async function webhook() {
  const { value } = await ElMessageBox.prompt('填写接收报名资格事件的 URL', '配置全局 Webhook');
  const x = await api('/admin/webhooks', 'POST', { url: value });
  secret.value = `Webhook HMAC-SHA256 密钥：${x.secret}`;
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
      <h1>管理后台</h1>
      <p class="subtitle">
        {{ auth.user?.isAdmin ? '全局配置、竞赛管理与系统任务' : '管理获授权的竞赛与任务' }}
      </p>
    </div>
    <el-button @click="refresh">刷新</el-button>
  </div>
  <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false"
    ><el-button text @click="refresh">重新加载</el-button></el-alert
  >
  <el-tabs v-model="tab">
    <el-tab-pane label="竞赛" name="contests" /><el-tab-pane label="任务" name="jobs" /><el-tab-pane
      label="评测平台"
      name="instances"
    />
    <template v-if="auth.user?.isAdmin"
      ><el-tab-pane label="用户权限" name="users" /><el-tab-pane
        label="API 与 Webhook"
        name="tokens" /><el-tab-pane label="全局设置" name="site" /><el-tab-pane
        label="邮件设置"
        name="mail" /><el-tab-pane label="GitHub 登录" name="github" /><el-tab-pane
        label="审计日志"
        name="audit"
    /></template>
  </el-tabs>
  <div class="panel" v-if="tab === 'mail' && auth.user?.isAdmin"><MailSettings /></div>
  <div class="panel" v-if="tab === 'github' && auth.user?.isAdmin"><GithubSettings /></div>
  <div class="panel" v-if="tab === 'contests'">
    <div class="actions" v-if="auth.user?.isAdmin">
      <router-link to="/admin/contests/new"
        ><el-button type="primary">创建竞赛</el-button></router-link
      >
    </div>
    <div class="card">
      <el-table :data="managedContests()"
        ><el-table-column label="竞赛名称" prop="title" min-width="280" /><el-table-column
          label="赛季"
          prop="season"
          width="100"
        /><el-table-column label="公开" width="90"
          ><template #default="{ row }">{{
            row.published ? '已发布' : '草稿'
          }}</template></el-table-column
        ><el-table-column label="模式" width="100"
          ><template #default="{ row }">{{
            row.policy.mode === 'TEAM' ? '团队' : '个人'
          }}</template></el-table-column
        ><el-table-column label="操作" width="200"
          ><template #default="{ row }"
            ><router-link :to="`/admin/contests/${row.id}`">编辑配置</router-link
            ><router-link
              :to="`/admin/contests/${row.id}?tab=registrations`"
              style="margin-left: 15px"
              >报名管理</router-link
            ></template
          ></el-table-column
        ></el-table
      >
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
              v-if="row.state === 'FAILED'"
              text
              type="primary"
              @click="api(`/admin/jobs/${row.id}/retry`, 'POST').then(refresh)"
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
          label="身份"
          min-width="200"
          ><template #default="{ row }"
            ><el-tag v-if="row.isAdmin">系统管理员</el-tag
            ><el-tag v-if="row.isCoach" type="success">指导老师</el-tag
            ><el-tag v-for="role in row.roles" :key="role.id"
              >竞赛管理员 · {{ contestName(role.contestId) }}</el-tag
            ></template
          ></el-table-column
        ><el-table-column label="操作" min-width="340"
          ><template #default="{ row }"
            ><el-button text type="primary" @click="editTags(row)">编辑标签</el-button
            ><el-button text type="primary" @click="inviteRole('CONTEST_ADMIN', row)"
              >授权竞赛</el-button
            ><el-button
              v-if="row.id !== auth.user?.id"
              text
              :type="row.isAdmin ? 'danger' : 'primary'"
              @click="
                row.isAdmin ? revokeRole(row, 'SYSTEM_ADMIN') : inviteRole('SYSTEM_ADMIN', row)
              "
              >{{ row.isAdmin ? '取消系统管理员' : '邀请系统管理员' }}</el-button
            ><el-button
              text
              :type="row.isCoach ? 'danger' : 'primary'"
              @click="row.isCoach ? revokeRole(row, 'COACH_ROLE') : inviteRole('COACH_ROLE', row)"
              >{{ row.isCoach ? '撤销指导老师' : '邀请指导老师' }}</el-button
            ><el-button
              v-for="role in row.roles"
              :key="role.id"
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
  <div class="panel" v-if="tab === 'instances'">
    <div class="notice">
      系统管理员维护平台地址与接入凭据，竞赛管理员可为获授权的竞赛配置比赛绑定。本站账号与比赛账号分别管理。
    </div>
    <div class="actions" v-if="auth.user?.isAdmin">
      <el-button type="primary" @click="editInstance()">添加 Hydro / DOMjudge 实例</el-button>
    </div>
    <div class="card">
      <h3>平台实例</h3>
      <el-table :data="instances"
        ><el-table-column label="名称" prop="name" /><el-table-column label="类型"
          ><template #default="{ row }">{{
            row.type === 'HYDRO' ? 'Hydro 评测平台' : 'DOMjudge 评测平台'
          }}</template></el-table-column
        ><el-table-column label="地址" prop="baseUrl" min-width="250" /><el-table-column
          label="操作"
          ><template #default="{ row }"
            ><el-button text v-if="auth.user?.isAdmin" @click="editInstance(row)"
              >编辑实例</el-button
            ></template
          ></el-table-column
        ></el-table
      >
    </div>
    <PlatformBindings :contests="managedContests()" :instances="instances" />
  </div>
  <div class="panel" v-if="tab === 'tokens'">
    <div class="actions">
      <el-button type="primary" @click="newToken">签发范围 Token</el-button
      ><el-button @click="webhook">配置签名 Webhook</el-button
      ><a href="/api/docs" target="_blank"><el-button>OpenAPI 文档</el-button></a>
    </div>
    <div v-if="secret" class="notice">
      密钥只展示一次，请复制保存：<code>{{ secret }}</code
      ><el-button text @click="secret = ''">隐藏</el-button>
    </div>
    <div class="card">
      <el-table :data="tokens"
        ><el-table-column label="名称" prop="name" /><el-table-column label="范围" min-width="200"
          ><template #default="{ row }">{{
            row.contestIds.map((id: string) => id.slice(0, 8)).join('、')
          }}</template></el-table-column
        ><el-table-column label="权限" min-width="250"
          ><template #default="{ row }">{{ row.scopes.join('、') }}</template></el-table-column
        ><el-table-column label="到期" min-width="170"
          ><template #default="{ row }">{{ date(row.expiresAt) }}</template></el-table-column
        ><el-table-column label="操作" width="100"
          ><template #default="{ row }"
            ><el-button
              v-if="!row.revoked"
              text
              type="danger"
              @click="api(`/admin/tokens/${row.id}`, 'DELETE').then(refresh)"
              >撤销</el-button
            ><span v-else>已撤销</span></template
          ></el-table-column
        ></el-table
      >
    </div>
  </div>
  <div class="panel" v-if="tab === 'site'">
    <div class="card">
      <h3>站点设置</h3>
      <el-form label-position="top"
        ><el-form-item label="站点名称"><el-input v-model="site.name" /></el-form-item
        ><el-form-item label="主色"><el-color-picker v-model="site.primaryColor" /></el-form-item
        ><el-form-item label="页脚"><el-input v-model="site.footer" /></el-form-item
        ><el-form-item label="公网地址" for="site-public-url"
          ><el-input
            id="site-public-url"
            v-model="site.publicUrl"
            placeholder="https://reg.example.org"
        /></el-form-item>
        <div class="notice">
          <strong>当前生效地址：{{ effectivePublicUrl }}</strong>
          <p>验证邮箱、找回密码与邀请链接使用此地址。环境配置的可信管理入口继续可用。</p>
          <p class="break-anywhere">链接预览：{{ site.publicUrl }}/invite/示例邀请</p>
        </div>
        <el-button type="primary" @click="saveSite">保存</el-button></el-form
      >
    </div>
    <div class="card">
      <h3>全局准考证模板</h3>
      <el-input v-model="templateName" style="margin-bottom: 15px" /><el-input
        v-model="templateSource"
        type="textarea"
        :rows="16"
        class="monospace"
      />
      <div class="actions">
        <el-button
          type="primary"
          @click="
            api('/admissions/templates', 'POST', {
              name: templateName,
              source: templateSource,
            }).then(refresh)
          "
          >保存新版本</el-button
        >
      </div>
      <div v-for="t in templates" :key="t.id">
        {{ t.name }} v{{ t.version }} <el-tag v-if="t.active">当前</el-tag
        ><el-button
          text
          @click="
            templateSource = t.source;
            templateName = t.name;
          "
          >载入</el-button
        >
      </div>
    </div>
    <div class="card">
      <h3>全局字段库</h3>
      <el-button type="primary" @click="editGlobalField()">添加全局字段</el-button>
      <p class="muted">竞赛可从字段库导入，并独立调整要求。</p>
      <el-table :data="fields"
        ><el-table-column label="键名" prop="key" /><el-table-column label="名称"
          ><template #default="{ row }">{{ row.definition.label }}</template></el-table-column
        ><el-table-column label="作用域"
          ><template #default="{ row }">{{ row.definition.scope }}</template></el-table-column
        ></el-table
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
  <el-dialog v-model="instanceDialog" title="Hydro / DOMjudge 接入配置" width="580px">
    <el-form label-position="top">
      <el-form-item label="名称" for="platform-name"
        ><el-input id="platform-name" v-model="instance.name"
      /></el-form-item>
      <el-form-item label="类型"
        ><el-select v-model="instance.type" @change="instance.credentials = {}"
          ><el-option value="HYDRO" label="Hydro 5.0.7" /><el-option
            value="DOMJUDGE"
            label="DOMjudge 9.0.1" /></el-select
      ></el-form-item>
      <el-form-item label="实例地址" for="platform-url"
        ><el-input
          id="platform-url"
          v-model="instance.baseUrl"
          placeholder="https://judge.example.org"
      /></el-form-item>
      <el-form-item v-if="instance.type === 'HYDRO'" label="插件 Token" for="platform-token"
        ><el-input
          id="platform-token"
          v-model="instance.credentials.token"
          type="password"
          show-password
          :placeholder="
            instance.id ? '留空保留已保存的 Token' : 'Hydro 桥接插件 Token，至少 32 位'
          "
      /></el-form-item>
      <template v-else
        ><el-form-item label="API 用户名" for="platform-username"
          ><el-input
            id="platform-username"
            v-model="instance.credentials.username"
            :placeholder="
              instance.id ? '留空保留已保存的用户名' : '具有 api_reader / api_writer 权限的账号'
            " /></el-form-item
        ><el-form-item label="API 密码" for="platform-password"
          ><el-input
            id="platform-password"
            v-model="instance.credentials.password"
            type="password"
            show-password
            :placeholder="
              instance.id ? '留空保留已保存的密码' : '填写 API 账号密码'
            " /></el-form-item
      ></template>
      <el-form-item label="允许使用的竞赛"
        ><el-select v-model="instance.allowedContestIds" multiple filterable style="width: 100%"
          ><el-option v-for="c in contests" :key="c.id" :value="c.id" :label="c.title" /></el-select
      ></el-form-item>
      <el-switch v-model="instance.enabled" active-text="启用平台实例" />
    </el-form>
    <template #footer
      ><el-button type="primary" @click="saveInstance">保存实例</el-button></template
    >
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
        ><el-select id="authorization-kind" v-model="authorization.kind" style="width: 100%"
          ><el-option
            v-for="(value, kind) in accountInvitationLabels"
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
  <el-dialog v-model="tokenDialog" title="创建 API Token" width="580px"
    ><el-form label-position="top"
      ><el-form-item label="名称"><el-input v-model="token.name" /></el-form-item
      ><el-form-item label="授权竞赛"
        ><el-select v-model="token.contestIds" multiple style="width: 100%"
          ><el-option
            v-for="c in contests"
            :key="c.id"
            :value="c.id"
            :label="c.title" /></el-select></el-form-item
      ><el-form-item label="权限"
        ><el-select v-model="token.scopes" multiple style="width: 100%"
          ><el-option
            v-for="s in [
              'contests:read',
              'registrations:read',
              'finance:read',
              'support:read',
              'integration:read',
              'integration:write',
            ]"
            :key="s"
            :value="s" /></el-select></el-form-item
      ><el-form-item label="可读资料字段"
        ><el-select v-model="token.fields" multiple allow-create filterable style="width: 100%"
          ><el-option
            v-for="s in [
              'PERSON.name',
              'PERSON.email',
              'COACH.name',
              'COACH.email',
              'REGISTRATION.organization',
              'REGISTRATION.participationType',
              'SUPPORT.text',
              'SUPPORT.attachments',
              'FINANCE.summary',
              ...fields.map((f) => `${f.definition.scope}.${f.key}`),
            ]"
            :key="s"
            :value="s" /></el-select></el-form-item
      ><el-form-item label="到期时间"
        ><el-date-picker
          v-model="token.expiresAt"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item></el-form
    ><template #footer
      ><el-button type="primary" @click="createToken">签发</el-button></template
    ></el-dialog
  >
  <el-dialog v-model="fieldDialog" title="全局字段" width="560px"
    ><el-form label-position="top"
      ><el-form-item label="键名"><el-input v-model="field.key" /></el-form-item
      ><el-form-item label="字段名称"><el-input v-model="field.label" /></el-form-item
      ><el-form-item label="作用域"
        ><el-select v-model="field.scope"
          ><el-option
            v-for="k in ['PERSON', 'TEAM', 'COACH', 'REGISTRATION']"
            :key="k"
            :value="k"
            :label="label(k)" /></el-select></el-form-item
      ><el-form-item label="类型"
        ><el-select v-model="field.type"
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
