<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  defaultFields,
  fieldSchema,
  adminLevelLabels,
  adminPermissionLabels,
} from '@contest-center/contracts';
import { api, auth, loadAuth, date, label } from '../api';
import type { Data, FieldDefinition } from '../types';
import DynamicFields from '../components/DynamicFields.vue';
import MailDelivery from '../components/MailDelivery.vue';
const route = useRoute(),
  router = useRouter();
const tab = ref(String(route.query.tab || 'overview')),
  busy = ref(false),
  profile = reactive<Data>({ profile: {} }),
  identity = reactive<Data>({ profile: {} }),
  requests = ref<Data[]>([]),
  sessions = ref<Data[]>([]),
  contests = ref<Data[]>([]),
  code = ref(''),
  github = ref({ enabled: false, linked: false }),
  closure = reactive({ confirmation: '', password: '', code: '' });
const teacher = computed(() => auth.user?.kind === 'TEACHER');
const locked = computed(() =>
  ['VERIFIED', 'RECORDED', 'PENDING'].includes(auth.user?.identityStatus ?? ''),
);
const stateLabels: Record<string, string> = {
  UNSUBMITTED: '未提交',
  RECORDED: '历史实名资料',
  PENDING: '审核中',
  VERIFIED: '已认证',
  REJECTED: '未通过',
};
const identityFields = computed<FieldDefinition[]>(() => {
  const fields = defaultFields
    .filter((f) => !['student_id', 'class_name'].includes(f.key) || !teacher.value)
    .map((f) => ({
      ...f,
      required: ['student_id', 'class_name', 'college', 'gender'].includes(f.key),
    }));
  return teacher.value
    ? [
        fieldSchema.parse({
          key: 'employee_id',
          label: '工号',
          scope: 'PERSON',
          type: 'text',
          required: true,
        }),
        fieldSchema.parse({
          key: 'employed_at',
          label: '入职日期',
          scope: 'PERSON',
          type: 'date',
          required: true,
        }),
        ...fields,
      ]
    : [
        ...fields,
        fieldSchema.parse({
          key: 'enrollment_year',
          label: '入学年份',
          scope: 'PERSON',
          type: 'number',
          required: true,
          help: '本科或当前学段入学的年份',
        }),
      ];
});
function reset() {
  if (!auth.user) return;
  Object.assign(profile, JSON.parse(JSON.stringify(auth.user)));
  Object.assign(identity, {
    kind: auth.user.kind || 'STUDENT',
    name: auth.user.name,
    profile: JSON.parse(JSON.stringify(auth.user.profile)),
    version: auth.user.version,
  });
}
async function refresh() {
  await loadAuth();
  reset();
  const result = await api('/auth/identity');
  requests.value = result.requests;
  sessions.value = await api('/auth/sessions');
}
onMounted(async () => {
  reset();
  const providers = await api('/auth/providers');
  github.value = providers.github;
  const result = await api('/auth/identity');
  requests.value = result.requests;
  sessions.value = await api('/auth/sessions');
  if (auth.user?.grants?.length) contests.value = await api('/contests?all=true');
});
async function save() {
  busy.value = true;
  try {
    await api('/auth/profile', 'PUT', {
      version: profile.version,
      name: profile.name,
      email: profile.email,
      profile: profile.profile,
    });
    await refresh();
    ElMessage.success('资料已保存');
    const next = String(route.query.next || '');
    if (auth.user?.profileComplete && /^\/(?!\/)[^\\\r\n]*$/.test(next)) await router.push(next);
  } finally {
    busy.value = false;
  }
}
async function submitIdentity() {
  busy.value = true;
  try {
    await api('/auth/identity', 'POST', { ...identity, version: auth.user!.version });
    await refresh();
    ElMessage.success('实名信息已提交，等待管理员审核');
  } finally {
    busy.value = false;
  }
}
async function avatar(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  try {
    const data = new FormData();
    data.append('file', file);
    const uploaded = await api('/files?purpose=AVATAR', 'POST', data);
    await api('/auth/profile', 'PUT', {
      version: auth.user!.version,
      name: auth.user!.name,
      profile: auth.user!.profile,
      avatarAttachmentId: uploaded.id,
    });
    await refresh();
    ElMessage.success('头像已更新');
  } finally {
    input.value = '';
    busy.value = false;
  }
}
async function resend() {
  await api('/auth/resend', 'POST', {
    next: route.query.next?.toString().startsWith('/invite/') ? route.query.next : undefined,
  });
  ElMessage.success('验证邮件已发送');
}
async function verify() {
  await api('/auth/verify-code', 'POST', { code: code.value });
  await refresh();
  code.value = '';
  ElMessage.success('邮箱验证成功');
}
async function revokeSession(id: string) {
  await api(`/auth/sessions/${id}`, 'DELETE');
  await loadAuth();
  if (!auth.user) {
    await router.replace('/login');
    return;
  }
  sessions.value = await api('/auth/sessions');
}
async function resign(grant: Data) {
  await ElMessageBox.confirm('卸任后将失去该项管理权限。', '卸任授权', { type: 'warning' });
  await api(`/auth/grants/${grant.id}`, 'DELETE');
  await refresh();
}
async function sendClosure() {
  await api('/auth/closure-code', 'POST');
  ElMessage.success('注销验证码已发送');
}
async function closeAccount() {
  await ElMessageBox.confirm(
    '注销后无法继续登录。历史报名与附件会保留；重新注册并通过实名审核后可以恢复查看。',
    '确认注销账号',
    { type: 'warning' },
  );
  await api('/auth/account', 'DELETE', closure);
  await loadAuth();
  await router.replace('/login');
  ElMessage.success('账号已注销');
}
const levelLabel = (p: string) => adminLevelLabels[p as keyof typeof adminLevelLabels] || p;
const permissionLabel = (p: string) =>
  adminPermissionLabels[p as keyof typeof adminPermissionLabels] || p;
const contestName = (id: string | null) =>
  id ? contests.value.find((c) => c.id === id)?.title || id : '全站';
</script>
<template>
  <template v-if="auth.user">
    <div class="profile-hero">
      <el-avatar :size="76" :src="auth.user.avatarUrl || undefined">{{
        auth.user.name.slice(0, 1)
      }}</el-avatar>
      <div class="profile-identity">
        <h1>{{ auth.user.profile.display_name || auth.user.name }}</h1>
        <el-tag>{{ teacher ? '教师' : '学生' }}</el-tag>
        <el-tag :type="auth.user.identityStatus === 'VERIFIED' ? 'success' : 'info'">{{
          stateLabels[auth.user.identityStatus || 'UNSUBMITTED']
        }}</el-tag>
      </div>
      <div class="profile-login-info">
        <strong>登录账号</strong>
        <p>{{ auth.user.username }}</p>
        <small>UID：{{ auth.user.id }}</small>
      </div>
    </div>
    <el-tabs v-model="tab" class="profile-tabs">
      <el-tab-pane label="总览" name="overview">
        <div class="profile-layout">
          <div class="card">
            <h3>个人信息</h3>
            <el-alert
              v-if="!auth.user.profileComplete"
              :title="
                teacher
                  ? '请完善工号、姓名、入职日期、院系和性别后再报名'
                  : '请完善学号、姓名、班级、学院、性别和入学年份后再报名'
              "
              type="warning"
              :closable="false"
            />
            <el-form label-position="top" @submit.prevent="save"
              ><div class="form-grid">
                <el-form-item label="姓名" for="profile-name"
                  ><el-input id="profile-name" v-model="profile.name" :disabled="locked"
                /></el-form-item>
                <el-form-item label="邮箱" for="profile-email"
                  ><el-input id="profile-email" v-model="profile.email" type="email"
                /></el-form-item>
                <el-form-item label="昵称" for="profile-nickname"
                  ><el-input
                    id="profile-nickname"
                    v-model="profile.profile.display_name"
                    maxlength="100"
                /></el-form-item>
                <el-form-item label="头像"
                  ><label class="file-upload-label"
                    >上传头像<input
                      type="file"
                      accept="image/png,image/jpeg"
                      :disabled="busy"
                      @change="avatar" /></label
                  ><span class="form-help">PNG / JPEG，最多 5 MB</span></el-form-item
                >
              </div>
              <template v-if="!locked"
                ><DynamicFields
                  :fields="identityFields"
                  scope="PERSON"
                  :answers="profile.profile"
                  prefix="profile"
              /></template>
              <div v-else class="identity-summary">
                <p>
                  {{ teacher ? '工号' : '学号' }}：{{
                    profile.profile[teacher ? 'employee_id' : 'student_id'] || '—'
                  }}
                </p>
                <p>
                  院系：{{ profile.profile.college || '—' }} ·
                  {{ profile.profile.class_name || '' }}
                </p>
                <el-button text type="primary" @click="tab = 'identity'"
                  >变更实名信息，提交管理员审核</el-button
                >
              </div>
              <el-button type="primary" native-type="submit" :loading="busy"
                >保存资料</el-button
              ></el-form
            >
          </div>
        </div>
        <div class="card">
          <div class="member-heading">
            <h3>邮箱验证</h3>
            <el-tag :type="auth.user.verified ? 'success' : 'warning'">{{
              auth.user.verified ? '邮箱已验证' : '邮箱未验证'
            }}</el-tag>
          </div>
          <div v-if="!auth.user.verified" class="toolbar">
            <el-input
              v-model="code"
              inputmode="numeric"
              maxlength="6"
              placeholder="邮件中的六位验证码"
              aria-label="邮箱验证码"
              style="max-width: 240px"
            /><el-button type="primary" @click="verify">验证邮箱</el-button
            ><el-button @click="resend">重新发送验证邮件</el-button>
          </div>
          <p class="form-help">修改邮箱后需重新验证，后续通知发送至当前邮箱。</p>
        </div>
        <MailDelivery :resource-id="auth.user.id" />
        <div class="card">
          <h3>登录会话</h3>
          <el-table :data="sessions"
            ><el-table-column prop="userAgent" label="设备" min-width="220" /><el-table-column
              label="登录时间"
              width="175"
              ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
            ><el-table-column label="操作" width="95"
              ><template #default="{ row }"
                ><el-button text type="danger" @click="revokeSession(row.id)"
                  >撤销</el-button
                ></template
              ></el-table-column
            ></el-table
          >
        </div>
      </el-tab-pane>
      <el-tab-pane label="实名认证" name="identity" lazy>
        <div class="card">
          <h3>实名信息</h3>
          <p class="form-help">
            学号 / 工号、姓名、班级和院系用于关联报名记录。资料变更需管理员审核，通过后生效。
          </p>
          <el-form label-position="top" @submit.prevent="submitIdentity"
            ><el-form-item label="姓名" for="identity-name"
              ><el-input id="identity-name" v-model="identity.name" /></el-form-item
            ><DynamicFields
              :fields="identityFields"
              scope="PERSON"
              :answers="identity.profile"
              prefix="identity"
            /><el-button
              type="primary"
              native-type="submit"
              :loading="busy"
              :disabled="requests.some((r) => r.status === 'PENDING')"
              >提交审核</el-button
            ></el-form
          >
        </div>
        <div class="card">
          <h3>审核记录</h3>
          <el-table :data="requests"
            ><el-table-column label="时间" width="180"
              ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
            ><el-table-column label="状态" width="110"
              ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
            ><el-table-column label="审核意见" prop="reason" min-width="180"
          /></el-table>
        </div>
      </el-tab-pane>
      <el-tab-pane v-if="auth.user.grants?.length" label="管理信息" name="management" lazy>
        <div class="card">
          <h3>我的管理授权</h3>
          <p class="form-help">学生与教师均可接受管理授权。授权到期或撤回后，管理权限立即失效。</p>
          <div v-for="grant in auth.user.grants" :key="grant.id" class="grant-card">
            <div class="member-heading">
              <strong>{{ levelLabel(grant.level) }} · {{ contestName(grant.contestId) }}</strong
              ><el-button text type="danger" @click="resign(grant)">卸任</el-button>
            </div>
            <p>期限：{{ grant.expiresAt ? date(grant.expiresAt) : '永久授权' }}</p>
            <div class="tag-list">
              <el-tag v-for="permission in grant.permissions" :key="permission" type="info">{{
                permissionLabel(permission)
              }}</el-tag>
            </div>
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane label="设置" name="settings" lazy>
        <div class="card" v-if="github.enabled || github.linked">
          <h3>GitHub 账号</h3>
          <p>
            {{
              github.linked
                ? '已绑定 GitHub，可使用 GitHub 登录。'
                : '绑定后可使用 GitHub 登录当前账号。'
            }}
          </p>
          <a
            v-if="!github.linked"
            href="/api/v1/auth/github?mode=link&next=%2Fme%2Fprofile%3Ftab%3Dsettings"
            ><el-button>绑定 GitHub</el-button></a
          ><el-button
            v-else
            :disabled="!auth.user.hasPassword"
            @click="api('/auth/github', 'DELETE').then(() => (github.linked = false))"
            >解除 GitHub 绑定</el-button
          >
          <p v-if="!auth.user.hasPassword" class="form-help">
            请通过邮箱找回密码设置本站密码后再解除绑定。
          </p>
        </div>
        <div class="card">
          <h3>注销账号</h3>
          <p>
            注销会结束登录并撤回管理授权。报名、财务记录与附件保留，重新注册并通过实名审核后可恢复查看。
          </p>
          <el-form label-position="top" @submit.prevent="closeAccount"
            ><el-form-item v-if="auth.user.hasPassword" label="当前密码" for="closure-password"
              ><el-input
                id="closure-password"
                v-model="closure.password"
                type="password"
                show-password
                autocomplete="current-password" /></el-form-item
            ><template v-else
              ><el-form-item label="邮箱验证码" for="closure-code"
                ><el-input
                  id="closure-code"
                  v-model="closure.code"
                  maxlength="6"
                  inputmode="numeric" /></el-form-item
              ><el-button @click="sendClosure">发送注销验证码</el-button></template
            ><el-form-item label="输入「注销账号」确认" for="closure-confirmation"
              ><el-input id="closure-confirmation" v-model="closure.confirmation" /></el-form-item
            ><el-button
              type="danger"
              native-type="submit"
              :disabled="closure.confirmation !== '注销账号'"
              >注销账号</el-button
            ></el-form
          >
        </div>
      </el-tab-pane>
    </el-tabs>
  </template>
</template>
<style scoped>
.profile-hero {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 30px;
  flex-wrap: wrap;
}
.profile-identity {
  min-width: 0;
  flex: 1;
}
.profile-identity h1 {
  font-size: 24px;
  overflow-wrap: anywhere;
  margin: 0 0 12px;
}
.profile-login-info {
  background: #f5f6f8;
  padding: 15px 20px;
  border-radius: 8px;
  font-size: 14px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.profile-login-info p {
  margin: 7px 0;
}
.profile-login-info small {
  color: #909399;
}
.identity-summary {
  background: #f7f9fc;
  padding: 12px 20px;
  margin-bottom: 18px;
  border-radius: 8px;
}
.grant-card {
  background: #f5f7fa;
  padding: 20px;
  border-radius: 8px;
  margin: 14px 0;
}
.tag-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.profile-tabs :deep(.el-tabs__content) {
  background: #f1f5f8;
  padding: 20px;
  border-radius: 8px;
}
.profile-tabs :deep(.card:last-child) {
  margin-bottom: 0;
}
@media (max-width: 760px) {
  .profile-tabs :deep(.el-tabs__content) {
    padding: 12px;
  }
  .profile-login-info {
    width: 100%;
  }
  .profile-hero {
    gap: 14px;
  }
}
</style>
