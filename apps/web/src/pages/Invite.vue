<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { accountInvitationKinds } from '@contest-center/contracts';
import { api, auth, loadAuth, date } from '../api';
import type { Data } from '../types';
const route = useRoute(),
  router = useRouter();
const invitation = ref<Data>(),
  rows = ref<Data[]>([]),
  registrationId = ref(''),
  error = ref(''),
  busy = ref(false);
const authorization = computed(() =>
  accountInvitationKinds.some((kind) => kind === invitation.value?.kind),
);
const descriptions: Record<string, string> = {
  ACCOUNT: '确认账号邀请后，您可以使用此账号登录并报名。',
  SYSTEM_ADMIN: '您将获得全站管理权限，包括竞赛、账号权限、财务、平台配置和全局设置。',
  CONTEST_ADMIN:
    '您将获得下方竞赛的配置、报名审核、财务核账、工单和准考证管理权限。其他竞赛不在此次授权范围内。',
  COACH_ROLE:
    '您将获得指导老师身份。参赛者通过链接与您确认关联后，您可以代填、修改和提交对应报名。',
};
async function refresh() {
  busy.value = true;
  error.value = '';
  try {
    await loadAuth();
    invitation.value = await api(`/invitations/${route.params.token}`);
    if (invitation.value?.kind === 'COACH_LINK') rows.value = await api('/registrations');
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
onMounted(refresh);
async function accept() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api(`/invitations/${route.params.token}/accept`, 'POST', {
      registrationId: registrationId.value || undefined,
    });
    await loadAuth();
    await router.push(result.redirectPath ?? `/registrations/${result.registrationId}`);
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="card invitation-card">
    <h1>
      {{
        invitation?.kind === 'ACCOUNT'
          ? '确认账号邀请'
          : authorization
            ? '确认授权邀请'
            : '确认邀请'
      }}
    </h1>
    <div v-if="error" class="error-state">{{ error }}</div>
    <template v-if="invitation && !error">
      <template v-if="authorization">
        <p>
          {{ invitation.inviter.name }} 邀请您{{
            invitation.kind === 'ACCOUNT' ? '确认账号邀请' : `担任${invitation.roleLabel}`
          }}。
        </p>
        <dl class="invitation-details">
          <dt>受邀账号</dt>
          <dd>{{ invitation.targetEmail }}</dd>
          <dt>授权身份</dt>
          <dd>{{ invitation.roleLabel }}</dd>
          <dt>授权范围</dt>
          <dd>
            {{
              invitation.contest?.title ||
              (invitation.kind === 'SYSTEM_ADMIN'
                ? '整个系统'
                : invitation.kind === 'COACH_ROLE'
                  ? '经确认关联的报名'
                  : '本人账号')
            }}
          </dd>
          <dt>有效期至</dt>
          <dd>{{ date(invitation.expiresAt) }}</dd>
        </dl>
        <p class="notice">{{ descriptions[invitation.kind] }}只有点击确认后才会生效。</p>
      </template>
      <template v-else>
        <p>
          {{
            invitation.kind === 'MEMBER'
              ? '您被邀请加入竞赛队伍'
              : invitation.kind === 'COACH_LINK'
                ? '关联指导老师'
                : '您被邀请担任指导老师'
          }}
        </p>
        <p class="subtitle">
          {{ invitation.registration?.contest?.title }} {{ invitation.registration?.teamName }}
        </p>
        <el-select
          v-if="invitation.kind === 'COACH_LINK'"
          v-model="registrationId"
          placeholder="选择您的报名"
          style="width: 100%; margin: 20px 0"
        >
          <el-option
            v-for="r in rows"
            :key="r.id"
            :value="r.id"
            :label="`${r.contest.title} · ${r.teamName || r.people[0]?.name}`"
          />
        </el-select>
        <p class="notice">确认后将建立成员或指导关系。指导老师可以代填、修改和提交关联报名。</p>
      </template>
      <div v-if="!auth.user?.verified" class="notice">
        请先验证当前账号的邮箱，再回来确认邀请。
        <router-link :to="{ path: '/account', query: { next: route.fullPath } }"
          >前往验证邮箱</router-link
        >
        <el-button text @click="refresh">我已验证，刷新状态</el-button>
      </div>
      <p v-if="invitation.accepted" class="notice">
        {{
          invitation.authorizationActive === false
            ? '此邀请已确认，但相应权限已被撤销。如需重新授权，请管理员生成新的邀请链接。'
            : '您已接受此邀请，无需重复确认。'
        }}
      </p>
      <el-button
        v-if="!invitation.accepted"
        type="primary"
        :loading="busy"
        :disabled="!auth.user?.verified || (invitation.kind === 'COACH_LINK' && !registrationId)"
        @click="accept"
        >确认接受</el-button
      >
      <router-link v-else :to="invitation.redirectPath || '/registrations'"
        ><el-button type="primary">继续前往</el-button></router-link
      >
    </template>
    <el-skeleton v-else-if="!error" :rows="4" />
    <el-button v-if="error" @click="refresh" :loading="busy">重新检查邀请</el-button>
  </div>
</template>
<style scoped>
.invitation-card {
  max-width: 650px;
  margin: 40px auto;
}
.invitation-card h1 {
  font-size: 25px;
  margin: 0 0 24px;
}
.invitation-details {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 16px;
  margin: 26px 0;
}
.invitation-details dt {
  color: #8791a0;
}
.invitation-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .invitation-card {
    margin: 16px auto;
  }
  .invitation-details {
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 12px;
    font-size: 14px;
  }
}
</style>
