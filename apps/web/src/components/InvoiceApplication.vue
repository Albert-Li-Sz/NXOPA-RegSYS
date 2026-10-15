<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { invoiceSchema, type ContestPolicy } from '@contest-center/contracts';
import { api, auth, money } from '../api';
import { useEditSession } from '../composables/useEditSession';
const props = defineProps<{
  registrationId: string;
  availableCents: number;
  policy: ContestPolicy;
}>();
const emit = defineEmits<{ submitted: [] }>();
const initialInvoiceType = props.policy.invoiceTypes[0] ?? 'NORMAL';
const model = ref({
  invoiceType: initialInvoiceType,
  titleType: initialInvoiceType === 'SPECIAL' ? 'ENTERPRISE' : 'PERSON',
  title: initialInvoiceType === 'SPECIAL' ? '' : (auth.user?.name ?? ''),
  taxId: '',
  amount: props.availableCents / 100,
  email: auth.user?.email ?? '',
  contactName: '',
  phone: '',
  address: '',
  bankName: '',
  bankAccount: '',
  remarks: '',
});
const confirmed = ref(false),
  busy = ref(false),
  error = ref('');
const edit = useEditSession(model, true);
watch(
  () => model.value.invoiceType,
  (invoiceType) => {
    if (invoiceType === 'SPECIAL' && model.value.titleType === 'PERSON')
      model.value.titleType = 'ENTERPRISE';
  },
  { flush: 'sync' },
);
watch(model, () => (confirmed.value = false), { deep: true, flush: 'sync' });
async function mayClose() {
  if (busy.value || !(await edit.mayLeave())) return false;
  edit.cancel();
  return true;
}
defineExpose({ mayClose, busy });
const taxRequired = computed(
  () => model.value.titleType === 'ENTERPRISE' || model.value.invoiceType === 'SPECIAL',
);
const optionalFields = {
  contactName: '联系人',
  phone: '联系电话',
  address: '地址',
  bankName: '开户银行',
  bankAccount: '银行账号',
};
async function submit() {
  if (busy.value) return;
  error.value = '';
  if (!confirmed.value) {
    error.value = '请先核对并确认开票信息';
    return;
  }
  const parsed = invoiceSchema.safeParse({
    ...model.value,
    amountCents: Math.round(model.value.amount * 100),
  });
  if (!parsed.success) {
    error.value = parsed.error.issues.map((x) => x.message).join('；');
    return;
  }
  if (parsed.data.amountCents > props.availableCents) {
    error.value = '申请金额超过可开票余额';
    return;
  }
  for (const key of props.policy.invoiceRequiredFields)
    if (!parsed.data[key]) {
      error.value = `请填写${optionalFields[key]}`;
      return;
    }
  busy.value = true;
  try {
    await api(`/finance/${props.registrationId}/invoices`, 'POST', parsed.data);
    edit.finish();
    ElMessage.success('开票申请已提交');
    emit('submitted');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '开票申请提交失败，请重试';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-form label-position="top" :disabled="busy" @submit.prevent="submit">
    <div class="notice">
      可开票余额：<strong>{{ money(availableCents) }}</strong>
      <p>请按开票方要求填写资料，确认后提交。</p>
      <p v-if="model.invoiceType === 'SPECIAL'">专用发票须使用单位抬头，并填写纳税人识别号。</p>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="form-grid">
      <el-form-item label="票种" required
        ><el-select v-model="model.invoiceType" filterable
          ><el-option
            v-for="v in policy.invoiceTypes"
            :key="v"
            :value="v"
            :label="v === 'NORMAL' ? '普通发票' : '专用发票'" /></el-select
      ></el-form-item>
      <el-form-item label="抬头类型" required
        ><el-select v-model="model.titleType" filterable
          ><el-option
            value="PERSON"
            label="个人"
            :disabled="model.invoiceType === 'SPECIAL'" /><el-option
            value="ENTERPRISE"
            label="企业" /><el-option value="ORGANIZATION" label="非企业单位" /></el-select
      ></el-form-item>
      <el-form-item label="发票抬头" required for="invoice-title"
        ><el-input id="invoice-title" v-model="model.title" maxlength="200"
      /></el-form-item>
      <el-form-item label="纳税人识别号" :required="taxRequired" for="invoice-tax"
        ><el-input
          id="invoice-tax"
          v-model="model.taxId"
          maxlength="100"
          placeholder="个人与非企业单位普票可留空"
      /></el-form-item>
      <el-form-item label="申请金额（元）" required
        ><el-input-number
          v-model="model.amount"
          :min="0.01"
          :max="availableCents / 100"
          :precision="2"
          :step="0.01"
      /></el-form-item>
      <el-form-item label="接收邮箱" required for="invoice-email"
        ><el-input id="invoice-email" v-model="model.email" type="email"
      /></el-form-item>
      <el-form-item
        v-for="(title, key) in optionalFields"
        :key="key"
        :label="title"
        :required="policy.invoiceRequiredFields.includes(key)"
        :for="`invoice-${key}`"
        ><el-input :id="`invoice-${key}`" v-model="model[key]"
      /></el-form-item>
    </div>
    <el-form-item label="备注" for="invoice-remarks"
      ><el-input
        id="invoice-remarks"
        v-model="model.remarks"
        type="textarea"
        :rows="3"
        maxlength="2000"
        show-word-limit
    /></el-form-item>
    <el-checkbox v-model="confirmed">我已核对抬头、税号、金额和接收信息</el-checkbox>
    <div class="actions">
      <el-button
        type="primary"
        native-type="submit"
        :disabled="!confirmed || availableCents <= 0"
        :loading="busy"
        >提交开票申请</el-button
      >
    </div>
  </el-form>
</template>
