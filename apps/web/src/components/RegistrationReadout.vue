<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onBeforeUnmount } from 'vue';
import { fieldVisible, policySchema } from '@contest-center/contracts';
import { label, money, handleAuthResponse } from '../api';
import type { Data, FieldDefinition } from '../types';
import PaginatedList from './PaginatedList.vue';
const props = defineProps<{ registration: Data }>();
const policy = computed(() =>
  policySchema.parse(props.registration.policySnapshot ?? props.registration.contest.policy),
);
const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'));
const preview = ref(''),
  mime = ref(''),
  text = ref(''),
  open = ref(false),
  loading = ref(false);
function fields(scope: string, answers: Data) {
  return (props.registration.fields as FieldDefinition[]).filter(
    (f) => f.scope === scope && fieldVisible(f, answers),
  );
}
const value = (v: unknown) =>
  v === undefined || v === null || v === ''
    ? '未填写'
    : Array.isArray(v)
      ? v.join('、')
      : typeof v === 'boolean'
        ? v
          ? '是'
          : '否'
        : String(v);
let sequence = 0;
let controller: AbortController | undefined;
function close() {
  sequence++;
  controller?.abort();
  loading.value = false;
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = '';
  text.value = '';
}
async function viewFile(id: string) {
  close();
  const current = sequence;
  controller = new AbortController();
  open.value = true;
  loading.value = true;
  const timer = setTimeout(() => controller?.abort(), 120000);
  try {
    const response = await fetch(`/api/v1/files/${id}`, {
      signal: controller.signal,
    });
    handleAuthResponse('/files', response.status);
    if (!response.ok) throw new Error('附件无法访问');
    const blob = await response.blob();
    const contentType = blob.type.split(';')[0]!.trim();
    const content =
      contentType === 'text/plain' && blob.size <= 1024 * 1024 ? await blob.text() : undefined;
    if (current !== sequence) return;
    mime.value = contentType;
    if (contentType === 'application/pdf' || blob.type.startsWith('image/'))
      preview.value = URL.createObjectURL(blob);
    else if (content !== undefined) text.value = content;
    else text.value = '此文件格式或大小暂不支持预览，请从附件列表下载查看。';
  } catch (e) {
    if (current === sequence) text.value = (e as Error).message;
  } finally {
    clearTimeout(timer);
    if (current === sequence) loading.value = false;
  }
}
onBeforeUnmount(close);
</script>
<template>
  <el-descriptions :column="2" border
    ><el-descriptions-item label="报名编号"
      >#{{ registration.number || '未提交' }}</el-descriptions-item
    ><el-descriptions-item label="状态">{{
      label(registration.displayState || registration.status)
    }}</el-descriptions-item
    ><el-descriptions-item v-if="policy.allowUnofficial" label="性质">{{
      registration.participationType === 'UNOFFICIAL' ? '非正式' : '正式'
    }}</el-descriptions-item
    ><el-descriptions-item label="参加资格">{{
      registration.eligible ? '已确认' : '待完成'
    }}</el-descriptions-item
    ><el-descriptions-item v-if="registration.contest.examSites.length" label="参赛考点">{{
      registration.examSite?.name || '未选择'
    }}</el-descriptions-item
    ><el-descriptions-item v-if="registration.examSite?.address" label="考点地址">{{
      registration.examSite.address
    }}</el-descriptions-item
    ><el-descriptions-item label="应收">{{ money(registration.feeCents) }}</el-descriptions-item
    ><el-descriptions-item label="净到账">{{
      money(registration.netPaidCents)
    }}</el-descriptions-item></el-descriptions
  >
  <div class="card" v-if="registration.teamName">
    <h3>队伍：{{ registration.teamName }}</h3>
    <p>{{ registration.teamEnglishName }}</p>
  </div>
  <div class="card" v-if="registration.organization">
    <h3>代表学校／单位</h3>
    <p>
      {{ registration.organization.name }} · {{ registration.organization.shortName }} ·
      {{ registration.organization.country }}
    </p>
  </div>
  <template v-for="scope in ['REGISTRATION', 'TEAM']" :key="scope"
    ><div
      class="card"
      v-if="
        fields(scope, registration.answers?.[scope === 'TEAM' ? 'team' : 'registration'] || {})
          .length
      "
    >
      <h3>{{ scope === 'TEAM' ? '团队资料' : '报名资料' }}</h3>
      <PaginatedList
        :items="
          fields(scope, registration.answers?.[scope === 'TEAM' ? 'team' : 'registration'] || {})
        "
        :page-key="`readout-fields-${scope}`"
        :always="false"
        v-slot="{ items }"
      >
        <dl class="readonly-fields">
          <template v-for="f in items" :key="f.key"
            ><dt>{{ f.label }}</dt>
            <dd>
              <el-button
                v-if="
                  ['file', 'photo'].includes(f.type) &&
                  registration.answers?.[scope === 'TEAM' ? 'team' : 'registration']?.[f.key]
                "
                text
                type="primary"
                @click="
                  viewFile(registration.answers[scope === 'TEAM' ? 'team' : 'registration'][f.key])
                "
                >预览附件</el-button
              ><span v-else>{{
                value(registration.answers?.[scope === 'TEAM' ? 'team' : 'registration']?.[f.key])
              }}</span>
            </dd></template
          >
        </dl>
      </PaginatedList>
    </div></template
  >
  <PaginatedList
    :items="registration.people"
    page-key="readout-people"
    :always="false"
    v-slot="{ items }"
  >
    <div class="card" v-for="p in items" :key="p.id">
      <h3>
        {{ p.name }} <el-tag v-if="p.captain && policy.mode === 'TEAM'" size="small">队长</el-tag>
      </h3>
      <p class="muted">{{ p.email || '未填写邮箱' }} · {{ p.confirmed ? '已确认' : '待确认' }}</p>
      <PaginatedList
        :items="fields('PERSON', p.answers || {})"
        page-key="readout-fields-PERSON"
        :always="false"
        v-slot="{ items: personFields }"
      >
        <dl class="readonly-fields">
          <template v-for="f in personFields" :key="f.key"
            ><dt>{{ f.label }}</dt>
            <dd>
              <el-button
                v-if="['file', 'photo'].includes(f.type) && p.answers[f.key]"
                text
                type="primary"
                @click="viewFile(p.answers[f.key])"
                >预览附件</el-button
              ><span v-else>{{ value(p.answers[f.key]) }}</span>
            </dd></template
          >
        </dl>
      </PaginatedList>
    </div>
  </PaginatedList>
  <PaginatedList
    :items="registration.coaches"
    page-key="readout-coaches"
    :always="false"
    v-slot="{ items }"
  >
    <div class="card" v-for="p in items" :key="p.id">
      <h3>指导老师：{{ p.user?.name || p.name }}</h3>
      <p class="muted">{{ p.user?.email }}</p>
      <PaginatedList
        :items="fields('COACH', p.answers || {})"
        page-key="readout-fields-COACH"
        :always="false"
        v-slot="{ items: coachFields }"
      >
        <dl class="readonly-fields">
          <template v-for="f in coachFields" :key="f.key"
            ><dt>{{ f.label }}</dt>
            <dd>
              <el-button
                v-if="['file', 'photo'].includes(f.type) && p.answers[f.key]"
                text
                type="primary"
                @click="viewFile(p.answers[f.key])"
                >预览附件</el-button
              ><span v-else>{{ value(p.answers[f.key]) }}</span>
            </dd></template
          >
        </dl>
      </PaginatedList>
    </div>
  </PaginatedList>
  <el-dialog
    v-model="open"
    title="附件预览"
    width="min(1100px, 94vw)"
    append-to-body
    destroy-on-close
    @closed="close"
    ><div v-loading="loading">
      <PdfPreview v-if="preview && mime === 'application/pdf'" :src="preview" /><img
        alt="报名附件图片预览"
        v-else-if="preview"
        :src="preview"
        style="max-width: 100%"
      />
      <pre v-else class="pre-line">{{ text }}</pre>
    </div></el-dialog
  >
</template>
