<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api, date, label } from '../api';
import type { Data } from '../types';
import RegistrationReadout from './RegistrationReadout.vue';
import PaginatedList from './PaginatedList.vue';
const props = defineProps<{ modelValue: boolean; registrationId: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; reviewed: []; next: [] }>();
const r = ref<Data>(),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  reason = ref(''),
  decision = ref('APPROVED'),
  participationType = ref('OFFICIAL');
let sequence = 0;
async function load(reset = false) {
  const current = ++sequence;
  loading.value = true;
  if (reset) {
    reason.value = '';
    decision.value = 'APPROVED';
    r.value = undefined;
  }
  error.value = '';
  try {
    const result = await api(`/registrations/${props.registrationId}`);
    if (current === sequence) {
      r.value = result;
      participationType.value = result.participationType;
      if (reset) decision.value = result.actions.amendReview ? '' : 'APPROVED';
    }
  } catch (e) {
    if (current === sequence) error.value = (e as Error).message;
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(
  () => [props.modelValue, props.registrationId],
  () => {
    if (props.modelValue && props.registrationId) void load(true);
  },
  { immediate: true },
);
const amending = computed(() => !!r.value?.actions.amendReview);
const canReview = computed(() => !!(r.value?.actions.review || amending.value));
const needsReason = computed(() => amending.value || decision.value !== 'APPROVED');
const paymentBlocked = computed(
  () =>
    decision.value === 'APPROVED' &&
    (r.value?.policySnapshot ?? r.value?.contest.policy)?.paymentSequence === 'PAYMENT_FIRST' &&
    r.value!.netPaidCents < r.value!.feeCents,
);
const changes = computed(() => {
  if (!r.value?.revisions?.length || r.value.revisions.length < 2) return [];
  const [newer, older] = r.value.revisions;
  const a = newer.snapshot,
    b = older.snapshot;
  const rows: string[] = [];
  if (a.teamName !== b.teamName) rows.push('队伍名称');
  if (a.participationType !== b.participationType) rows.push('正式／非正式性质');
  if (JSON.stringify(a.organization) !== JSON.stringify(b.organization)) rows.push('代表单位');
  if (JSON.stringify(a.answers) !== JSON.stringify(b.answers)) rows.push('报名或团队字段');
  if (JSON.stringify(a.people) !== JSON.stringify(b.people)) rows.push('成员资料');
  if (JSON.stringify(a.coaches) !== JSON.stringify(b.coaches)) rows.push('指导老师资料');
  return rows;
});
async function review(next = false) {
  if (!r.value) return;
  if (!decision.value || (amending.value && decision.value === r.value.review)) {
    error.value = '请选择新的审核结论';
    return;
  }
  if (needsReason.value && !reason.value.trim()) {
    error.value = '请填写审核意见';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api(`/registrations/${r.value.id}/review`, 'POST', {
      version: r.value.version,
      decision: decision.value,
      reason: reason.value,
      participationType: participationType.value,
    });
    emit('reviewed');
    if (next) emit('next');
    else emit('update:modelValue', false);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-dialog
    class="registration-review-dialog"
    align-center
    :model-value="modelValue"
    :title="amending ? '修改审核' : '报名审核'"
    width="min(1120px, 95vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-skeleton v-if="loading" :rows="8" animated />
    <template v-else-if="r"
      ><RegistrationReadout :registration="r" />
      <el-alert
        v-if="changes.length"
        type="info"
        :closable="false"
        :title="`本次提交变化：${changes.join('、')}`"
      />
      <div class="card">
        <h3>审核历史</h3>
        <el-empty
          v-if="!r.reviews?.length"
          description="暂无人工审核记录"
          :image-size="50"
        /><PaginatedList
          v-else
          :items="r.reviews"
          page-key="review-history"
          :always="false"
          v-slot="{ items }"
          ><el-timeline
            ><el-timeline-item
              v-for="review in items"
              :key="review.id"
              :timestamp="date(review.createdAt)"
              >{{ label(review.details.decision) }} · {{ review.reviewerName || review.actorId }}
              <p>{{ review.details.reason || '无附加意见' }}</p></el-timeline-item
            ></el-timeline
          ></PaginatedList
        >
      </div>
      <el-alert
        v-if="!canReview"
        type="warning"
        :closable="false"
        title="当前报名不能审核，请等待提交或补正后重新提交"
      />
      <el-form v-else label-position="top"
        ><el-form-item label="审核结论"
          ><el-radio-group v-model="decision"
            ><el-radio-button v-if="!amending || r.review !== 'APPROVED'" value="APPROVED"
              >通过</el-radio-button
            ><el-radio-button v-if="!amending || r.review !== 'CORRECTION'" value="CORRECTION"
              >退回补正</el-radio-button
            ><el-radio-button v-if="!amending || r.review !== 'REJECTED'" value="REJECTED"
              >拒绝</el-radio-button
            ></el-radio-group
          ></el-form-item
        ><el-form-item
          v-if="(r.policySnapshot || r.contest.policy).allowUnofficial"
          label="确认参加性质"
          ><el-radio-group v-model="participationType"
            ><el-radio value="OFFICIAL">正式</el-radio
            ><el-radio value="UNOFFICIAL">非正式</el-radio></el-radio-group
          ></el-form-item
        ><el-form-item label="审核意见" :required="needsReason"
          ><el-input
            v-model="reason"
            type="textarea"
            :rows="4"
            maxlength="3000"
            placeholder="说明补正项、拒绝原因或审核建议" /></el-form-item
        ><el-alert
          v-if="paymentBlocked"
          type="warning"
          :closable="false"
          title="此活动要求先确认足额到账；目前可退回补正或拒绝，暂不能审核通过"
      /></el-form>
    </template>
    <el-alert v-if="error" :title="error" type="error" :closable="false"
      ><el-button text @click="load(false)">重新加载报名（保留审核意见）</el-button></el-alert
    >
    <template #footer
      ><el-button :disabled="busy" @click="emit('update:modelValue', false)">关闭</el-button
      ><el-button
        v-if="canReview"
        type="primary"
        :loading="busy"
        :disabled="loading || paymentBlocked"
        @click="review(false)"
        >{{ amending ? '保存审核修改' : '确认审核' }}</el-button
      ><el-button
        v-if="r?.actions.review"
        type="success"
        :loading="busy"
        :disabled="loading || paymentBlocked"
        @click="review(true)"
        >审核并查看下一条</el-button
      ></template
    >
  </el-dialog>
</template>
