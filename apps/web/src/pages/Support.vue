<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, auth, date, label, upload } from '../api';
import type { Data, ContestView } from '../types';
const route = useRoute(),
  router = useRouter(),
  rows = ref<Data[]>([]),
  ticket = ref<Data>(),
  contests = ref<ContestView[]>([]),
  createDialog = ref(!!route.query.registrationId),
  busy = ref(false);
const form = reactive({
    title: '',
    category: '报名咨询',
    contestId: String(route.query.contestId ?? ''),
    registrationId: String(route.query.registrationId ?? ''),
    text: '',
    attachments: [] as string[],
  }),
  reply = reactive({ text: '', status: '', attachments: [] as string[] });
const manager = computed(
  () =>
    auth.user?.isAdmin ||
    (ticket.value?.contestId && auth.user?.contestIds.includes(ticket.value.contestId)),
);
async function refresh() {
  if (route.params.id) ticket.value = await api(`/support/${route.params.id}`);
  else rows.value = await api('/support');
}
onMounted(async () => {
  await refresh();
  contests.value = await api('/contests');
});
async function attach(e: Event, list: string[]) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    const f = await upload(file, undefined, ticket.value?.id);
    list.push(f.id);
  }
}
async function create() {
  busy.value = true;
  try {
    const t = await api('/support', 'POST', {
      ...form,
      contestId: form.contestId || undefined,
      registrationId: form.registrationId || undefined,
    });
    router.push(`/support/${t.id}`);
  } finally {
    busy.value = false;
  }
}
async function send() {
  busy.value = true;
  try {
    await api(`/support/${ticket.value!.id}/messages`, 'POST', {
      ...reply,
      version: ticket.value!.version,
      status: reply.status || undefined,
    });
    reply.text = '';
    reply.attachments = [];
    await refresh();
  } finally {
    busy.value = false;
  }
}
</script>
<template>
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
        <div class="card" v-for="m in ticket.messages" :key="m.id">
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
        <div class="card">
          <h3>添加回复</h3>
          <el-input
            v-model="reply.text"
            type="textarea"
            :rows="5"
            placeholder="描述问题或补充处理信息"
            aria-label="工单回复"
          />
          <div class="actions">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.txt"
              @change="attach($event, reply.attachments)"
            /><el-tag v-if="reply.attachments.length">{{ reply.attachments.length }} 个附件</el-tag
            ><el-select
              v-model="reply.status"
              clearable
              placeholder="回复后的状态"
              style="width: 170px"
              ><el-option
                v-for="s in manager
                  ? ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']
                  : ['OPEN', 'CLOSED']"
                :key="s"
                :value="s"
                :label="label(s)" /></el-select
            ><el-button type="primary" :loading="busy" @click="send">提交回复</el-button>
          </div>
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
    </div></template
  >
  <div v-else class="panel">
    <div class="card">
      <el-table
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
    </div>
  </div>
  <el-dialog v-model="createDialog" title="新建工单" width="600px"
    ><el-form label-position="top"
      ><el-form-item label="所属竞赛"
        ><el-select
          v-model="form.contestId"
          clearable
          placeholder="留空表示系统工单"
          style="width: 100%"
          ><el-option
            v-for="c in contests"
            :key="c.id"
            :value="c.id"
            :label="c.title" /></el-select></el-form-item
      ><el-form-item label="标题" for="ticket-title"
        ><el-input id="ticket-title" v-model="form.title" /></el-form-item
      ><el-form-item label="分类"
        ><el-select v-model="form.category"
          ><el-option
            v-for="s in ['报名咨询', '财务问题', '准考证', '平台联动', '其他']"
            :key="s"
            :value="s" /></el-select></el-form-item
      ><el-form-item label="描述" for="ticket-text"
        ><el-input id="ticket-text" v-model="form.text" type="textarea" :rows="5" /></el-form-item
      ><el-form-item label="附件"
        ><input type="file" @change="attach($event, form.attachments)" /><span
          v-if="form.attachments.length"
        >
          已上传 {{ form.attachments.length }} 个</span
        ></el-form-item
      ></el-form
    ><template #footer
      ><el-button type="primary" :loading="busy" @click="create">提交工单</el-button></template
    ></el-dialog
  >
</template>
