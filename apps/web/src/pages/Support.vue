<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { ElMessage } from 'element-plus';
import MailDelivery from '../components/MailDelivery.vue';
import { canManage } from '../permissions';
import { api, auth, date, label, upload } from '../api';
import ListPagination from '../components/ListPagination.vue';
import { usePagedList } from '../composables/usePagedList';
import type { Data, ContestView } from '../types';
import PaginatedList from '../components/PaginatedList.vue';
import { useEditSession } from '../composables/useEditSession';
import { useOperationGuard } from '../composables/usePendingOperations';
const list = usePagedList('support', () => '/support');
const route = useRoute(),
  router = useRouter(),
  rows = list.items,
  ticket = ref<Data>(),
  contests = ref<ContestView[]>([]),
  createDialog = ref(!!route.query.registrationId),
  busy = ref(false),
  uploading = ref(false),
  submitError = ref(''),
  loading = ref(true),
  loadError = ref('');
const form = reactive({
    title: '',
    category: '报名咨询',
    contestId: String(route.query.contestId ?? ''),
    registrationId: String(route.query.registrationId ?? ''),
    text: '',
    attachments: [] as string[],
  }),
  reply = reactive({ text: '', status: '', attachments: [] as string[] });
const working = computed(() => busy.value || uploading.value);
function mayNavigate() {
  if (!working.value) return true;
  ElMessage.info(uploading.value ? '附件正在上传，请稍候再离开' : '正在提交，请稍候再离开');
  return false;
}
onBeforeRouteLeave(mayNavigate);
onBeforeRouteUpdate(mayNavigate);
useOperationGuard(mayNavigate);
const createEdit = useEditSession(form),
  replyEdit = useEditSession(reply, !!route.params.id);
watch(
  createDialog,
  (open) => {
    if (open) {
      submitError.value = '';
      createEdit.begin();
    }
  },
  { immediate: true },
);
async function closeCreate(done: () => void) {
  if (working.value || !(await createEdit.mayLeave())) return;
  createEdit.cancel();
  submitError.value = '';
  done();
}
const manager = computed(
  () =>
    auth.user?.isAdmin || (ticket.value?.contestId && canManage(ticket.value.contestId, 'SUPPORT')),
);
async function refresh() {
  loading.value = true;
  loadError.value = '';
  try {
    if (route.params.id) ticket.value = await api(`/support/${route.params.id}`);
    else await list.load();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '工单加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  await refresh();
  try {
    contests.value = await api('/contests');
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '竞赛列表加载失败';
  }
});
async function attach(e: Event, list: string[]) {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file || working.value) return;
  if (list.length >= 10) {
    ElMessage.warning('每条消息最多上传 10 个附件');
    input.value = '';
    return;
  }
  uploading.value = true;
  submitError.value = '';
  try {
    const f = await upload(file, undefined, ticket.value?.id);
    list.push(f.id);
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : '附件上传失败，请重试';
  } finally {
    uploading.value = false;
    input.value = '';
  }
}
async function create() {
  if (working.value) return;
  busy.value = true;
  submitError.value = '';
  try {
    const t = await api('/support', 'POST', {
      ...form,
      contestId: form.contestId || undefined,
      registrationId: form.registrationId || undefined,
    });
    createEdit.finish();
    createDialog.value = false;
    busy.value = false;
    await router.push(`/support/${t.id}`);
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : '工单提交失败，请重试';
  } finally {
    busy.value = false;
  }
}
async function send() {
  if (working.value || !ticket.value) return;
  busy.value = true;
  submitError.value = '';
  try {
    await api(`/support/${ticket.value!.id}/messages`, 'POST', {
      ...reply,
      version: ticket.value!.version,
      status: reply.status || undefined,
    });
    reply.text = '';
    reply.status = '';
    reply.attachments = [];
    replyEdit.begin();
    await refresh();
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : '回复提交失败，请重试';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-result v-if="loadError" icon="warning" title="工单加载失败" :sub-title="loadError"
    ><template #extra><el-button @click="refresh">重新加载</el-button></template></el-result
  >
  <el-skeleton v-else-if="loading && !ticket" :rows="8" animated />
  <template v-else>
    <div class="page-heading">
      <div>
        <h1>{{ ticket ? ticket.title : '工单中心' }}</h1>
        <p class="subtitle">{{ ticket ? '查看回复并补充信息' : '提交问题，查看处理进度' }}</p>
      </div>
      <el-button v-if="!ticket" type="primary" @click="createDialog = true">新建工单</el-button
      ><router-link v-else to="/support">返回工单列表</router-link>
    </div>
    <template v-if="ticket"
      ><div class="toolbar">
        <el-tag>{{ label(ticket.status) }}</el-tag
        ><span class="muted">{{ ticket.category }} · {{ date(ticket.createdAt) }}</span>
      </div>
      <div class="two-columns">
        <div>
          <PaginatedList
            :items="ticket.messages"
            page-key="support-messages"
            :always="false"
            start-at-end
            v-slot="{ items }"
          >
            <div class="card" v-for="m in items" :key="m.id">
              <div class="member-heading">
                <strong>{{ m.actor?.name || '用户' }}</strong
                ><span class="muted">{{ date(m.createdAt) }}</span>
              </div>
              <p class="pre-line">{{ m.text }}</p>
              <a
                v-for="id in m.attachments"
                :key="id"
                :href="`/api/v1/files/${id}`"
                target="_blank"
                style="margin-right: 15px"
                >下载附件</a
              >
            </div>
          </PaginatedList>
          <div class="card">
            <h3>添加回复</h3>
            <el-input
              v-model="reply.text"
              :disabled="working"
              type="textarea"
              :rows="5"
              placeholder="描述问题或补充处理信息"
              aria-label="工单回复"
            />
            <div class="actions">
              <input
                type="file"
                accept=".pdf,.png,.jpg,.txt"
                :disabled="working || reply.attachments.length >= 10"
                @change="attach($event, reply.attachments)"
              /><el-tag v-if="reply.attachments.length"
                >{{ reply.attachments.length }} 个附件</el-tag
              ><span v-if="uploading" class="form-help" role="status">附件正在上传…</span
              ><el-select
                v-model="reply.status"
                :disabled="working"
                clearable
                placeholder="回复后的状态"
                style="width: 170px"
                filterable
                ><el-option
                  v-for="s in manager
                    ? ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']
                    : ['OPEN', 'CLOSED']"
                  :key="s"
                  :value="s"
                  :label="label(s)" /></el-select
              ><el-button
                type="primary"
                :loading="busy"
                :disabled="working || !reply.text.trim()"
                @click="send"
                >提交回复</el-button
              >
            </div>
            <el-alert v-if="submitError" :title="submitError" type="error" :closable="false" />
          </div>
        </div>
        <aside class="card">
          <h3>工单信息</h3>
          <p>编号：{{ ticket.id.slice(0, 8) }}</p>
          <p>当前版本：{{ ticket.version }}</p>
          <router-link v-if="ticket.registrationId" :to="`/registrations/${ticket.registrationId}`"
            >查看关联报名 →</router-link
          >
        </aside>
      </div>
      <MailDelivery :resource-id="ticket.id"
    /></template>
    <div v-else class="panel">
      <div class="card">
        <div class="toolbar">
          <el-input
            v-model="list.filters.value.search"
            placeholder="搜索工单"
            clearable
          /><el-select
            v-model="list.filters.value.status"
            clearable
            placeholder="处理状态"
            filterable
            ><el-option
              v-for="state in ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']"
              :key="state"
              :value="state"
              :label="label(state)"
          /></el-select>
        </div>
        <div class="toolbar">
          <el-date-picker
            v-model="list.filters.value.from"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="开始时间"
          /><el-date-picker
            v-model="list.filters.value.to"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            placeholder="结束时间"
          />
        </div>
        <el-alert
          v-if="list.error.value"
          :title="list.error.value"
          type="error"
          :closable="false"
        /><el-table
          :data="rows"
          @row-click="(row: Data) => router.push(`/support/${row.id}`)"
          style="cursor: pointer"
          ><el-table-column label="标题" prop="title" min-width="260" /><el-table-column
            label="分类"
            prop="category"
            width="150"
          /><el-table-column label="状态" width="140"
            ><template #default="{ row }"
              ><el-tag>{{ label(row.status) }}</el-tag></template
            ></el-table-column
          ><el-table-column label="最后更新" min-width="180"
            ><template #default="{ row }">{{ date(row.updatedAt) }}</template></el-table-column
          ></el-table
        >
        <ListPagination
          v-model:page="list.page.value"
          v-model:size="list.pageSize.value"
          :total="list.total.value"
          :loading="list.loading.value"
        />
      </div>
    </div>
    <el-dialog
      v-model="createDialog"
      title="新建工单"
      width="600px"
      :before-close="closeCreate"
      :close-on-click-modal="!working"
      :close-on-press-escape="!working"
      :show-close="!working"
      ><el-form label-position="top" :disabled="working"
        ><el-form-item label="所属竞赛"
          ><el-select
            v-model="form.contestId"
            clearable
            placeholder="留空表示系统工单"
            style="width: 100%"
            filterable
            ><el-option
              v-for="c in contests"
              :key="c.id"
              :value="c.id"
              :label="c.title" /></el-select></el-form-item
        ><el-form-item label="标题" for="ticket-title"
          ><el-input id="ticket-title" v-model="form.title" /></el-form-item
        ><el-form-item label="分类"
          ><el-select v-model="form.category" filterable
            ><el-option
              v-for="s in ['报名咨询', '财务问题', '准考证', '平台导入', '其他']"
              :key="s"
              :value="s" /></el-select></el-form-item
        ><el-form-item label="描述" for="ticket-text"
          ><el-input id="ticket-text" v-model="form.text" type="textarea" :rows="5" /></el-form-item
        ><el-form-item label="附件"
          ><input
            type="file"
            :disabled="working || form.attachments.length >= 10"
            @change="attach($event, form.attachments)"
          /><span v-if="form.attachments.length"> 已上传 {{ form.attachments.length }} 个</span
          ><span v-if="uploading" class="form-help" role="status">附件正在上传…</span></el-form-item
        ></el-form
      ><el-alert v-if="submitError" :title="submitError" type="error" :closable="false" />
      <template #footer
        ><el-button
          type="primary"
          :loading="busy"
          :disabled="working || !form.title.trim() || !form.text.trim()"
          @click="create"
          >提交工单</el-button
        ></template
      ></el-dialog
    >
  </template>
</template>
