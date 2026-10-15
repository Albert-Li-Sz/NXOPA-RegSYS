<script setup lang="ts">
import PaginatedTable from '../components/PaginatedTable.vue';
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { api, money, date, label, upload } from '../api';
import type { Data } from '../types';
import { ownUser } from '../permissions';
import InvoiceApplication from '../components/InvoiceApplication.vue';
const route = useRoute(),
  account = ref<Data>(),
  error = ref(''),
  busy = ref(false),
  invoiceDialog = ref(false);
const invoiceForm = ref<InstanceType<typeof InvoiceApplication>>();
async function closeInvoiceApplication(done: () => void) {
  if (!invoiceForm.value || (await invoiceForm.value.mayClose())) done();
}
async function load() {
  try {
    account.value = await api(`/finance/accounts/${route.params.id}`);
    error.value = '';
  } catch (e) {
    error.value = String((e as Error).message);
  }
}
onMounted(load);
const available = computed(() =>
  Math.max(
    0,
    (account.value?.netPaidCents || 0) -
      (account.value?.invoices || [])
        .filter((x: Data) => ['REQUESTED', 'ISSUED'].includes(x.status))
        .reduce((n: number, x: Data) => n + x.amountCents, 0),
  ),
);
async function action(path: string, body: Data) {
  busy.value = true;
  try {
    await api(path, 'POST', body);
    await load();
  } finally {
    busy.value = false;
  }
}
async function refund() {
  const { value } = await ElMessageBox.prompt('输入退款金额（元）', '申请退款', {
    inputPattern: /^\d+(\.\d{1,2})?$/,
    inputErrorMessage: '请输入有效金额',
  });
  const reason = await ElMessageBox.prompt('填写退款原因', '申请退款');
  await action(`/finance/${account.value!.id}/refunds`, {
    amountCents: Math.round(Number(value) * 100),
    reason: reason.value,
  });
}
async function refundReview(row: Data, decision: string) {
  let reference;
  if (decision === 'COMPLETED')
    reference = (await ElMessageBox.prompt('填写实际退款参考号', '记录退款')).value;
  else
    await ElMessageBox.confirm(
      `确认${decision === 'APPROVED' ? '通过' : '拒绝'}退款申请？`,
      '退款审核',
    );
  await action(`/finance/refunds/${row.id}/review`, { decision, reference });
}
async function voucherReview(row: Data, decision: string) {
  let reference = row.reference;
  if (decision === 'CONFIRMED') {
    await ElMessageBox.confirm(
      `确认申报金额 ${money(row.amountCents)} 已实际到账？金额不符请拒绝凭证。`,
      '核账确认',
    );
    if (!reference)
      reference = (
        await ElMessageBox.prompt('填写银行或支付平台的交易参考号', '到账参考号', {
          inputValidator: (value: string) => !!value.trim() || '请填写参考号',
        })
      ).value;
  }
  const reason = (await ElMessageBox.prompt('填写核账说明', '核账', { inputType: 'textarea' }))
    .value;
  await action(`/finance/vouchers/${row.id}/review`, { decision, reason, reference });
}
async function invoiceReview(row: Data, decision: string) {
  const reason = (await ElMessageBox.prompt('填写处理说明', '发票处理')).value;
  await action(`/finance/invoices/${row.id}/review`, { decision, reason });
}
async function issue(row: Data, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const attachment = await upload(file);
  await action(`/finance/invoices/${row.id}/review`, {
    decision: 'ISSUED',
    attachmentId: attachment.id,
  });
}
async function reverse(row: Data) {
  const reason = (await ElMessageBox.prompt('填写冲正原因', '收款冲正')).value;
  await action(`/finance/ledger/${row.id}/reverse`, { reason });
}
</script>
<template>
  <div class="crumb">
    <router-link
      v-if="account?.canManage && !account.canEdit"
      :to="`/admin/contests/${account.contestId}?tab=finance`"
      >活动财务记录</router-link
    >
    <router-link v-else to="/registrations?tab=finance">我的财务记录</router-link><span>／</span
    ><span>财务详情</span>
  </div>
  <el-alert v-if="error" :title="error" type="error" />
  <template v-if="account"
    ><div class="page-heading">
      <div>
        <h1>{{ account.contest.title }} · 财务记录</h1>
        <p class="subtitle">
          报名 #{{ account.number || '未提交' }}
          <span v-if="account.cancelledAt"> · 报名已永久删除</span>
        </p>
      </div>
      <el-button @click="load">刷新</el-button>
    </div>
    <div class="stats">
      <div class="stat">
        <span>{{ account.cancelledAt ? '原报名费用' : '应收金额' }}</span>
        <div class="value">{{ money(account.feeCents) }}</div>
      </div>
      <div class="stat">
        <span>净到账</span>
        <div class="value">{{ money(account.netPaidCents) }}</div>
      </div>
      <div class="stat">
        <span>可开票余额</span>
        <div class="value">{{ money(available) }}</div>
      </div>
    </div>
    <div class="toolbar">
      <el-button
        v-if="account.canEdit && account.policy.refundsEnabled && account.netPaidCents > 0"
        @click="refund"
        >申请退款</el-button
      ><el-button
        v-if="account.canEdit && account.invoicePolicy.invoicesEnabled && available > 0"
        @click="invoiceDialog = true"
        >申请发票</el-button
      >
    </div>
    <div class="card">
      <h3>缴费凭证</h3>
      <PaginatedTable page-key="finance-account-vouchers" :data="account.vouchers"
        ><el-table-column prop="payer" label="付款人" /><el-table-column label="金额"
          ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
        ><el-table-column label="状态"
          ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
        ><el-table-column label="凭证"
          ><template #default="{ row }"
            ><a :href="`/api/v1/files/${row.attachmentId}`" target="_blank">查看凭证</a></template
          ></el-table-column
        ><el-table-column label="操作" min-width="180"
          ><template #default="{ row }"
            ><template
              v-if="
                account.canManage &&
                !ownUser(account.ownerId) &&
                !ownUser(row.createdBy ?? '') &&
                row.status === 'PENDING'
              "
              ><el-button
                text
                type="success"
                :disabled="busy"
                @click="voucherReview(row, 'CONFIRMED')"
                >确认到账</el-button
              ><el-button
                text
                type="danger"
                :disabled="busy"
                @click="voucherReview(row, 'REJECTED')"
                >拒绝</el-button
              ></template
            ></template
          ></el-table-column
        ></PaginatedTable
      >
    </div>
    <div class="card">
      <h3>退款</h3>
      <PaginatedTable page-key="finance-account-refunds" :data="account.refunds"
        ><el-table-column label="金额"
          ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
        ><el-table-column prop="reason" label="原因" /><el-table-column label="状态"
          ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
        ><el-table-column prop="reference" label="退款参考号" /><el-table-column
          label="操作"
          min-width="180"
          ><template #default="{ row }"
            ><template
              v-if="
                account.canManage && !ownUser(account.ownerId) && !ownUser(row.requestedBy ?? '')
              "
              ><template v-if="row.status === 'REQUESTED'"
                ><el-button text @click="refundReview(row, 'APPROVED')">通过</el-button
                ><el-button text type="danger" @click="refundReview(row, 'REJECTED')"
                  >拒绝</el-button
                ></template
              ><el-button
                v-if="row.status === 'APPROVED'"
                text
                :disabled="
                  row.amountCents > account.feeCents &&
                  ownUser(row.approvedBy ?? row.handledBy ?? '')
                "
                title="超过应收费用的退款需要另一位财务管理员复核"
                @click="refundReview(row, 'COMPLETED')"
                >记录实际退款</el-button
              ></template
            ></template
          ></el-table-column
        ></PaginatedTable
      >
    </div>
    <div class="card">
      <h3>发票</h3>
      <PaginatedTable page-key="finance-account-invoices" :data="account.invoices"
        ><el-table-column prop="title" label="抬头" /><el-table-column label="金额"
          ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
        ><el-table-column label="状态"
          ><template #default="{ row }">{{ label(row.status) }}</template></el-table-column
        ><el-table-column label="发票文件"
          ><template #default="{ row }"
            ><a v-if="row.attachmentId" :href="`/api/v1/files/${row.attachmentId}`" target="_blank"
              >查看发票</a
            ></template
          ></el-table-column
        ><el-table-column label="操作" min-width="220"
          ><template #default="{ row }"
            ><template v-if="account.canManage"
              ><template v-if="row.status === 'REQUESTED'"
                ><label class="upload-label"
                  >上传发票并开具<input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    @change="issue(row, $event)" /></label
                ><el-button text type="danger" @click="invoiceReview(row, 'REJECTED')"
                  >拒绝</el-button
                ></template
              ><el-button
                v-if="row.status === 'ISSUED'"
                text
                type="danger"
                @click="invoiceReview(row, 'VOID')"
                >作废</el-button
              ></template
            ></template
          ></el-table-column
        ></PaginatedTable
      >
    </div>
    <div class="card">
      <h3>账簿</h3>
      <PaginatedTable page-key="finance-account-ledger" :data="account.ledger"
        ><el-table-column label="类型"
          ><template #default="{ row }">{{ label(row.kind) }}</template></el-table-column
        ><el-table-column label="金额"
          ><template #default="{ row }">{{ money(row.amountCents) }}</template></el-table-column
        ><el-table-column prop="note" label="说明" /><el-table-column label="时间"
          ><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="{ row }"
            ><span v-if="row.reversed" class="muted">已冲正</span
            ><el-button
              v-else-if="account.canManage && row.kind === 'PAYMENT'"
              text
              type="danger"
              @click="reverse(row)"
              >冲正</el-button
            ></template
          ></el-table-column
        ></PaginatedTable
      >
    </div>
    <el-dialog
      v-model="invoiceDialog"
      title="申请发票"
      width="760px"
      destroy-on-close
      :before-close="closeInvoiceApplication"
      :close-on-click-modal="false"
      :close-on-press-escape="!invoiceForm?.busy"
      :show-close="!invoiceForm?.busy"
      ><InvoiceApplication
        ref="invoiceForm"
        :registration-id="account.id"
        :available-cents="available"
        :policy="account.invoicePolicy"
        @submitted="
          invoiceDialog = false;
          load();
        "
    /></el-dialog>
  </template>
</template>
