<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { defaultFields, invitationReturnPathSchema } from '@contest-center/contracts';
import { api, auth, loadAuth, date } from '../api';
import type { Data } from '../types';
import DynamicFields from '../components/DynamicFields.vue';
const route = useRoute(),
  router = useRouter(),
  mode = ref(route.query.mode === 'register' ? 'register' : 'login'),
  busy = ref(false),
  notice = ref('');
const form = reactive({ account: '', email: '', username: '', name: '', password: '' });
const profile = reactive<Data>({});
const sessions = ref<Data[]>([]);
const github = ref({ enabled: false, linked: false });
const profileFields = defaultFields.map((field) => ({
  ...field,
  required: ['student_id', 'class_name', 'college', 'gender'].includes(field.key),
}));
const githubErrors: Record<string, string> = {
  state: 'GitHub 登录已过期或校验失败，请重新尝试',
  cancelled: '已取消 GitHub 授权',
  email: 'GitHub 账号没有已验证邮箱，请先在 GitHub 完成邮箱验证',
  email_exists: '该邮箱已注册，请先使用本站密码登录，再在账号中心绑定 GitHub',
  bound: '该 GitHub 账号已绑定其他用户，或当前用户已有 GitHub 绑定',
  failed: 'GitHub 登录失败，请重新尝试或使用邮箱登录',
};
function nextPath() {
  const next = String(route.query.next ?? '/contests');
  return /^\/(?!\/)[^\\\r\n]*$/.test(next) ? next : '/contests';
}
watch(
  () => auth.user,
  async (current) => {
    if (current) {
      Object.assign(profile, JSON.parse(JSON.stringify(current)));
      sessions.value = await api('/auth/sessions');
    }
  },
  { immediate: true },
);
const action = computed(() => String(route.params.action ?? ''));
const invitationReturn = computed(() => {
  const result = invitationReturnPathSchema.safeParse(route.query.next);
  return result.success ? result.data : undefined;
});
onMounted(async () => {
  github.value = (await api('/auth/providers')).github;
  if (route.query.github_error)
    notice.value = githubErrors[String(route.query.github_error)] ?? githubErrors.failed!;
  if (action.value === 'verify') {
    busy.value = true;
    try {
      await api('/auth/verify', 'POST', { token: route.query.token });
      await loadAuth();
      notice.value = '邮箱已验证，现在可以报名或确认授权。';
      if (auth.user && invitationReturn.value) {
        await router.replace(invitationReturn.value);
        return;
      }
    } finally {
      busy.value = false;
    }
  }
  if (action.value === 'reset') mode.value = 'reset';
  if (auth.user) {
    Object.assign(profile, JSON.parse(JSON.stringify(auth.user)));
    sessions.value = await api('/auth/sessions');
  }
});
async function submit() {
  busy.value = true;
  try {
    if (mode.value === 'forgot') {
      await api('/auth/forgot', 'POST', { email: form.email });
      notice.value = '如果邮箱已注册，我们会发送重置邮件。';
      return;
    }
    if (mode.value === 'reset') {
      await api('/auth/reset', 'POST', { token: route.query.token, password: form.password });
      await loadAuth();
      ElMessage.success('密码已重置，请登录');
      await router.replace('/login');
      return;
    }
    const data = await api(
      `/auth/${mode.value === 'register' ? 'register' : 'login'}`,
      'POST',
      mode.value === 'register'
        ? { ...form, next: invitationReturn.value }
        : { account: form.account, password: form.password },
    );
    auth.user = data.user;
    auth.csrf = data.csrf;
    router.push(
      data.user.profileComplete ||
        (mode.value !== 'register' && (data.user.isAdmin || data.user.isCoach))
        ? nextPath()
        : { path: '/account', query: { next: nextPath() } },
    );
  } finally {
    busy.value = false;
  }
}
async function save() {
  busy.value = true;
  try {
    await api('/auth/profile', 'PUT', {
      version: profile.version,
      name: profile.name,
      email: profile.email,
      profile: profile.profile,
    });
    await loadAuth();
    Object.assign(profile, JSON.parse(JSON.stringify(auth.user)));
    ElMessage.success('资料已保存');
    if (auth.user?.profileComplete && route.query.next) await router.push(nextPath());
  } finally {
    busy.value = false;
  }
}
async function resend() {
  await api('/auth/resend', 'POST', { next: invitationReturn.value });
  ElMessage.success('验证邮件已发送');
}
async function revokeSession(id: string) {
  await api(`/auth/sessions/${id}`, 'DELETE');
  await loadAuth();
  if (!auth.user) {
    sessions.value = [];
    await router.replace('/login');
  } else {
    sessions.value = sessions.value.filter((session) => session.id !== id);
  }
}
</script>
<template>
  <div v-if="notice" class="notice">{{ notice }}</div>
  <div v-if="invitationReturn && action !== 'verify'" class="notice">
    您正在通过邀请链接确认账号或授权，登录并验证邮箱后即可继续。<router-link
      v-if="auth.user?.verified"
      :to="invitationReturn"
      >返回邀请确认</router-link
    >
  </div>
  <div v-if="!auth.user || mode === 'reset'" class="auth-layout">
    <div class="auth-intro">
      <span class="eyebrow">OPENATOM CLUB · NANXIAO</span>
      <h1>每一次竞赛，<br />从这里开始。</h1>
      <p>个人报名、团队协作、指导老师关联，<br />在同一个地方管理您的参赛旅程。</p>
      <router-link to="/contests">浏览竞赛 →</router-link>
    </div>
    <div class="auth-card card">
      <h2>
        {{
          mode === 'register'
            ? '创建账号'
            : mode === 'forgot'
              ? '找回密码'
              : mode === 'reset'
                ? '设置新密码'
                : '欢迎回来'
        }}
      </h2>
      <p class="subtitle" style="margin-bottom: 25px">
        {{
          mode === 'register'
            ? '注册后完善个人资料并验证邮箱，即可报名'
            : '登录南晓开放原子社在线报名系统'
        }}
      </p>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item v-if="mode === 'login'" label="用户名或邮箱" for="account"
          ><el-input
            id="account"
            v-model="form.account"
            autocomplete="username"
            placeholder="输入用户名或邮箱"
        /></el-form-item>
        <el-form-item v-if="['register', 'forgot'].includes(mode)" label="邮箱" for="email"
          ><el-input id="email" v-model="form.email" type="email" autocomplete="email"
        /></el-form-item>
        <template v-if="mode === 'register'"
          ><el-form-item label="用户名" for="username"
            ><el-input
              id="username"
              v-model="form.username"
              placeholder="3–32 位字母、数字或下划线"
              autocomplete="username" /></el-form-item
          ><el-form-item label="姓名" for="name"
            ><el-input id="name" v-model="form.name" autocomplete="name" /></el-form-item
        ></template>
        <el-form-item v-if="mode !== 'forgot'" label="密码" for="password"
          ><el-input
            id="password"
            v-model="form.password"
            type="password"
            show-password
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="至少 10 位"
        /></el-form-item>
        <el-button
          type="primary"
          native-type="submit"
          :loading="busy"
          style="width: 100%; height: 42px"
          >{{
            mode === 'register'
              ? '注册账号'
              : mode === 'forgot'
                ? '发送重置邮件'
                : mode === 'reset'
                  ? '重置密码'
                  : '登录'
          }}</el-button
        >
      </el-form>
      <a
        v-if="github.enabled && ['login', 'register'].includes(mode)"
        :href="`/api/v1/auth/github?next=${encodeURIComponent(nextPath())}`"
        class="github-login"
        ><el-button style="width: 100%; margin-top: 14px">使用 GitHub 登录</el-button></a
      >
      <div class="auth-links">
        <el-button text @click="mode = mode === 'register' ? 'login' : 'register'">{{
          mode === 'register' ? '已有账号？登录' : '创建账号'
        }}</el-button
        ><el-button text @click="mode = 'forgot'">忘记密码</el-button>
      </div>
    </div>
  </div>
  <template v-else
    ><div class="page-heading">
      <div>
        <h1>账号中心</h1>
        <p class="subtitle">完善个人资料，管理邮箱和登录会话</p>
      </div>
      <el-tag :type="auth.user.verified ? 'success' : 'warning'">{{
        auth.user.verified ? '邮箱已验证' : '邮箱未验证'
      }}</el-tag>
    </div>
    <div v-if="!auth.user.verified" class="notice">
      请验证邮箱后提交报名。
      <el-button text type="primary" @click="resend">重新发送验证邮件</el-button>
    </div>
    <div class="profile-layout">
      <div class="card">
        <h3>个人资料</h3>
        <el-alert
          v-if="!auth.user.profileComplete"
          title="请完善学号、姓名、班级、学院和性别后再报名"
          type="warning"
          :closable="false"
          style="margin-bottom: 16px"
        />
        <el-form label-position="top"
          ><div class="form-grid">
            <el-form-item label="姓名" for="profile-name" required
              ><el-input id="profile-name" v-model="profile.name" /></el-form-item
            ><el-form-item label="邮箱" for="profile-email"
              ><el-input id="profile-email" v-model="profile.email"
            /></el-form-item>
          </div>
          <DynamicFields
            :fields="profileFields"
            scope="PERSON"
            :answers="profile.profile || {}"
            prefix="profile"
          /><el-form-item label="指导老师身份"
            ><el-tag :type="auth.user?.isCoach ? 'success' : 'info'">{{
              auth.user?.isCoach ? '已获授权' : '尚未授权'
            }}</el-tag
            ><span class="form-help" style="margin-left: 10px"
              >由管理员生成邀请链接，确认后生效。</span
            ></el-form-item
          ><el-button type="primary" :loading="busy" @click="save">保存资料</el-button></el-form
        >
      </div>
    </div>
    <div class="card" v-if="github.enabled || github.linked">
      <h3>GitHub 账号</h3>
      <p>
        {{
          github.linked
            ? '已绑定 GitHub，可使用 GitHub 登录。'
            : '绑定后可使用 GitHub 登录当前账号。'
        }}
      </p>
      <a v-if="!github.linked" href="/api/v1/auth/github?mode=link&next=%2Faccount"
        ><el-button>绑定 GitHub</el-button></a
      >
      <el-button
        v-else
        :disabled="!auth.user.hasPassword"
        @click="api('/auth/github', 'DELETE').then(() => (github.linked = false))"
        >解除 GitHub 绑定</el-button
      >
      <p v-if="github.linked && !auth.user.hasPassword" class="form-help">
        如需解除绑定，请先通过邮箱找回流程设置本站密码。
      </p>
    </div>
    <div class="card">
      <h3>登录会话</h3>
      <el-table :data="sessions"
        ><el-table-column label="设备" prop="userAgent" min-width="220" /><el-table-column
          label="登录时间"
          width="190"
          ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
        ><el-table-column label="操作" width="100"
          ><template #default="{ row }"
            ><el-button text type="danger" @click="revokeSession(row.id)">撤销</el-button></template
          ></el-table-column
        ></el-table
      >
    </div></template
  >
</template>
<style scoped>
.auth-layout {
  display: grid;
  grid-template-columns: 1fr 440px;
  gap: 70px;
  max-width: 1050px;
  margin: 50px auto;
}
.auth-intro {
  padding-top: 75px;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 3px;
  color: #2080f0;
}
.auth-intro h1 {
  font-size: 40px;
  line-height: 1.5;
  font-weight: 600;
  margin: 20px 0;
}
.auth-intro p {
  color: #909399;
  line-height: 2;
  margin-bottom: 32px;
}
.auth-card {
  padding: 34px;
}
.auth-links {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
}
@media (max-width: 760px) {
  .auth-layout {
    grid-template-columns: 1fr;
    margin: 10px auto;
    gap: 22px;
  }
  .auth-intro {
    padding: 0;
  }
  .auth-intro h1 {
    font-size: 27px;
  }
  .auth-intro p {
    display: none;
  }
  .auth-card {
    padding: 24px;
  }
}
</style>
