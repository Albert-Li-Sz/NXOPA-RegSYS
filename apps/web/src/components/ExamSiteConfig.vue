<script setup lang="ts">
import ListPagination from './ListPagination.vue';
import { useLocalPagination } from '../composables/useLocalPagination';
import type { ExamSiteView } from '../types';
const sites = defineModel<ExamSiteView[]>({ required: true });
defineProps<{ editing: boolean }>();
const list = useLocalPagination('contest-exam-sites', () => sites.value);
function add() {
  sites.value.push({ id: crypto.randomUUID(), name: '', address: '', enabled: true });
  list.page.value = Math.ceil(sites.value.length / list.pageSize.value);
}
</script>
<template>
  <div class="card" data-testid="exam-site-config">
    <div class="page-heading">
      <h3>考点选择</h3>
      <el-button v-if="editing" :disabled="sites.length >= 100" @click="add">新增考点</el-button>
    </div>
    <p class="form-help">
      配置后，选手提交报名时须选择一个考点，团队成员共用同一考点。最多配置 100 个考点。
      已使用的考点可停用，已有选择会保留；删除前须先调整关联的报名与考场。
    </p>
    <p v-if="!sites.length" class="muted">暂未配置考点，报名时无需选择。</p>
    <div data-pagination-key="contest-exam-sites">
      <div v-for="{ row: site, index } in list.entries.value" :key="site.id" class="card">
        <div class="form-grid">
          <el-form-item
            :label="`考点 ${index + 1} 名称`"
            required
            :for="`exam-site-${site.id}-name`"
          >
            <el-input :id="`exam-site-${site.id}-name`" v-model="site.name" maxlength="100" />
          </el-form-item>
          <el-form-item :label="`考点 ${index + 1} 地址`" :for="`exam-site-${site.id}-address`">
            <el-input :id="`exam-site-${site.id}-address`" v-model="site.address" maxlength="300" />
          </el-form-item>
        </div>
        <div class="toolbar">
          <el-switch
            v-model="site.enabled"
            :aria-label="`考点 ${index + 1} 开放选择`"
            active-text="开放选择"
          />
          <el-button
            v-if="editing"
            text
            type="danger"
            :aria-label="`删除考点 ${index + 1}`"
            @click="sites.splice(index, 1)"
            >删除考点</el-button
          >
        </div>
      </div>
      <ListPagination
        v-if="sites.length > 20"
        v-model:page="list.page.value"
        v-model:size="list.pageSize.value"
        :total="sites.length"
      />
    </div>
  </div>
</template>
