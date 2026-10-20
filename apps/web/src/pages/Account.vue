<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { defaultFields, invitationReturnPathSchema } from '@contest-center/contracts';
import { api, auth, loadAuth, date } from '../api';
import type { Data } from '../types';
import DynamicFields from '../components/DynamicFields.vue';
import { operationsSettled } from '../composables/usePendingOperations';
import ProfileCenter from './ProfileCenter.vue';
const route = useRoute(),
  router = useRouter(),
  mode = ref(route.query.mode === 'register' ? 'register' : 'login'),
  busy = ref(false),
  codeBusy = ref(false),
  registrationToken = ref(''),
  codeSentAt = ref(0),
  notice = ref('');
const form = reactive({
  account: '',
  email: '',
  username: '',
  name: '',
  password: '',
  code: '',
  kind: 'STUDENT',
  identifier: '',
  enrollmentYear: new Date().getFullYear(),
  employedAt: '',
});
const profile = reactive<Data>({});
const sessions = ref<Data[]>([]);
const github = ref({ enabled: false, linked: false });
const feishu = ref({ enabled: false, linked: false });
const feishuClaim = computed(() =>
  typeof route.query.feishu_claim === 'string' ? route.query.feishu_claim : undefined,
);
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
watch(
  () => form.email,
  () => {
    registrationToken.value = '';
    form.code = '';
    codeSentAt.value = 0;
  },
);
async function sendRegistrationCode() {
  codeBusy.value = true;
  try {
    const result = await api('/auth/register/code', 'POST', {
      email: form.email,
      next: invitationReturn.value,
    });
    registrationToken.value = result.token;
    codeSentAt.value = Date.now();
    ElMessage.success('如邮箱可用于注册，验证码将在 10 分钟内有效；已有账号请登录或找回密码。');
  } finally {
    codeBusy.value = false;
  }
}
onMounted(async () => {
  const providers = await api('/auth/providers');
  github.value = providers.github;
  feishu.value = providers.feishu;
  if (feishuClaim.value && !auth.user) {
    try {
      const signup = await api(
        `/auth/feishu/signup?claim=${encodeURIComponent(feishuClaim.value)}`,
      );
      form.name = signup.name;
      form.email = signup.email;
      notice.value =
        '飞书身份已确认。请完成邮箱验证和注册资料后创建账号；已有账号可登录后在个人信息中绑定飞书。';
    } catch (error) {
      notice.value = error instanceof Error ? error.message : '飞书验证已过期';
    }
  }
  if (route.query.feishu_error) {
    notice.value =
      (
        {
          state: '飞书授权已过期，请重新登录',
          cancelled: '已取消飞书授权',
          bound: '此飞书账号已绑定其他用户',
          failed: '飞书登录失败，请重试或使用邮箱登录',
        } as Record<string, string>
      )[String(route.query.feishu_error)] || '飞书登录失败';
  }
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
    } catch (error) {
      notice.value = error instanceof Error ? error.message : '邮箱验证失败，请重新申请验证邮件';
    } finally {
      busy.value = false;
    }
  }
  if (action.value === 'reset') mode.value = 'reset';
});
async function submit() {
  busy.value = true;
  try {
    if (mode.value === 'forgot') {
      await api('/auth/forgot', 'POST', { email: form.email });
      notice.value =
        '如果邮箱已注册，我们会发送重置邮件。请输入邮件中的六位验证码，或打开邮件链接。';
      mode.value = 'resetCode';
      return;
    }
    if (['reset', 'resetCode'].includes(mode.value)) {
      await api(
        mode.value === 'resetCode' ? '/auth/reset-code' : '/auth/reset',
        'POST',
        mode.value === 'resetCode'
          ? { email: form.email, code: form.code, password: form.password }
          : { token: route.query.token, password: form.password },
      );
      await loadAuth({ allowSignedOut: true });
      ElMessage.success('密码已重置，请登录');
      await router.replace('/login');
      return;
    }
    const data = await api(
      `/auth/${mode.value === 'register' ? 'register' : 'login'}`,
      'POST',
      mode.value === 'register'
        ? {
            ...form,
            token: registrationToken.value,
            feishuClaim: feishuClaim.value,
            employedAt: form.kind === 'TEACHER' ? form.employedAt : undefined,
            enrollmentYear: form.kind === 'STUDENT' ? form.enrollmentYear : undefined,
            next: invitationReturn.value,
          }
        : { account: form.account, password: form.password },
    );
    auth.user = data.user;
    auth.csrf = data.csrf;
    router.push(
      invitationReturn.value ||
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
  if (!operationsSettled()) return;
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
  await loadAuth({ allowSignedOut: true });
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
  <div v-if="!auth.user || ['reset', 'resetCode'].includes(mode)" class="auth-layout">
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
              : ['reset', 'resetCode'].includes(mode)
                ? '设置新密码'
                : '欢迎回来'
        }}
      </h2>
      <p class="subtitle" style="margin-bottom: 25px">
        {{
          mode === 'register'
            ? '先验证邮箱，再创建账号；注册后完善个人资料即可报名'
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
        <el-form-item
          v-if="['register', 'forgot', 'resetCode'].includes(mode)"
          label="邮箱"
          for="email"
          ><el-input id="email" v-model="form.email" type="email" autocomplete="email"
        /></el-form-item>
        <template v-if="mode === 'register'"
          ><el-form-item label="邮箱验证码" for="register-code" required>
            <div class="registration-code">
              <el-input
                id="register-code"
                v-model="form.code"
                maxlength="6"
                inputmode="numeric"
                autocomplete="one-time-code"
                placeholder="邮件中的六位验证码"
              />
              <el-button
                :loading="codeBusy"
                :disabled="!form.email || busy"
                @click="sendRegistrationCode"
                >{{ codeSentAt ? '重新发送验证码' : '发送验证码' }}</el-button
              >
            </div> </el-form-item
          ><el-form-item label="用户名" for="username"
            ><el-input
              id="username"
              v-model="form.username"
              placeholder="3–32 位字母、数字或下划线"
              autocomplete="username" /></el-form-item
          ><el-form-item label="姓名" for="name"
            ><el-input id="name" v-model="form.name" autocomplete="name" /></el-form-item
        ></template>
        <template v-if="mode === 'register'"
          ><el-form-item label="用户类型"
            ><el-radio-group v-model="form.kind"
              ><el-radio-button value="STUDENT">学生</el-radio-button
              ><el-radio-button value="TEACHER">教师</el-radio-button></el-radio-group
            ></el-form-item
          ><el-form-item
            :label="form.kind === 'TEACHER' ? '工号' : '学号'"
            for="register-identifier"
            required
            ><el-input id="register-identifier" v-model="form.identifier" /></el-form-item
          ><el-form-item
            v-if="form.kind === 'STUDENT'"
            label="入学年份"
            for="register-year"
            required
            ><el-input-number
              id="register-year"
              v-model="form.enrollmentYear"
              :min="1950"
              :max="new Date().getFullYear() + 1" /></el-form-item
          ><el-form-item v-else label="入职日期" for="register-employment" required
            ><el-date-picker
              id="register-employment"
              v-model="form.employedAt"
              type="date"
              value-format="YYYY-MM-DD" /></el-form-item
        ></template>
        <el-form-item v-if="mode === 'resetCode'" label="邮箱验证码" for="reset-code"
          ><el-input id="reset-code" v-model="form.code" maxlength="6" inputmode="numeric"
        /></el-form-item>
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
          :disabled="mode === 'register' && (!registrationToken || !/^\d{6}$/.test(form.code))"
          style="width: 100%; height: 42px"
          >{{
            mode === 'register'
              ? '注册账号'
              : mode === 'forgot'
                ? '发送重置邮件'
                : ['reset', 'resetCode'].includes(mode)
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
      <a
        v-if="feishu.enabled && ['login', 'register'].includes(mode)"
        :href="`/api/v1/auth/feishu?next=${encodeURIComponent(nextPath())}`"
        class="social-login"
        ><el-button style="width: 100%; margin-top: 14px">使用飞书登录</el-button></a
      >
      <div class="auth-links">
        <el-button text @click="mode = mode === 'register' ? 'login' : 'register'">{{
          mode === 'register' ? '已有账号？登录' : '创建账号'
        }}</el-button
        ><el-button text @click="mode = 'forgot'">忘记密码</el-button>
      </div>
    </div>
  </div>
  <ProfileCenter v-else />
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
.registration-code {
  display: flex;
  gap: 10px;
  width: 100%;
}
.registration-code .el-input {
  min-width: 0;
  flex: 1;
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
