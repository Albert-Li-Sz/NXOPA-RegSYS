<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { downloadArchive } from '../api';
import { canManage } from '../permissions';
import type { ContestView } from '../types';
const props = defineProps<{ contests: ContestView[]; initialContestId?: string }>();
const contestId = ref(props.initialContestId ?? '');
const available = computed(() =>
  props.contests.filter((c) => c.modules.integrations && canManage(c.id, 'INTEGRATIONS')),
);
const platform = ref('HYDRO'),
  includeUnofficial = ref(true),
  importMode = ref('FOLLOW');
const officialGroupId = ref(''),
  unofficialGroupId = ref(''),
  busy = ref(false);
async function download() {
  if (!contestId.value || busy.value) return;
  busy.value = true;
  try {
    await downloadArchive(
      `/contests/${contestId.value}/platform-exports`,
      {
        platform: platform.value,
        includeUnofficial: includeUnofficial.value,
        importMode: importMode.value,
        ...(platform.value === 'DOMJUDGE'
          ? {
              officialGroupId: officialGroupId.value.trim() || undefined,
              unofficialGroupId: unofficialGroupId.value.trim() || undefined,
            }
          : {}),
      },
      `${platform.value.toLowerCase()}-${contestId.value}.zip`,
    );
    ElMessage.success('平台导入包已导出，请按包内教程在目标平台导入');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="card platform-exports">
    <h3>导出平台导入文件</h3>
    <p class="subtitle">将取得参赛资格的报名导出为 Hydro 或 DOMjudge 导入包。</p>
    <el-form label-position="top" @submit.prevent="download">
      <el-form-item v-if="!initialContestId" label="本站活动／竞赛" for="export-contest">
        <el-select
          id="export-contest"
          v-model="contestId"
          placeholder="选择已启用平台文件导出的活动"
          filterable
          :disabled="busy"
        >
          <el-option v-for="c in available" :key="c.id" :value="c.id" :label="c.title" />
        </el-select>
      </el-form-item>
      <el-form-item label="目标平台">
        <el-radio-group v-model="platform" :disabled="busy">
          <el-radio value="HYDRO">Hydro 最新版（Onsite Toolkit）</el-radio>
          <el-radio value="DOMJUDGE">DOMjudge 9.x</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="参赛性质导出策略">
        <el-radio-group v-model="importMode" :disabled="busy">
          <el-radio value="FOLLOW">跟随报名性质</el-radio>
          <el-radio value="FORCE_UNOFFICIAL">全部作为非正式参赛</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="报名范围">
        <el-switch v-model="includeUnofficial" active-text="包含非正式报名" :disabled="busy" />
      </el-form-item>
      <div v-if="platform === 'DOMJUDGE'" class="form-grid">
        <el-form-item label="正式分组外部 ID（可选）" for="export-official-group">
          <el-input
            id="export-official-group"
            v-model="officialGroupId"
            placeholder="留空自动生成活动专属分组"
            :disabled="busy"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="非正式分组外部 ID（可选）" for="export-unofficial-group">
          <el-input
            id="export-unofficial-group"
            v-model="unofficialGroupId"
            placeholder="应与正式组不同"
            :disabled="busy"
            maxlength="64"
          />
        </el-form-item>
      </div>
      <p class="notice" v-if="platform === 'HYDRO'">
        包含 teams.json、账号密码表和导入说明。使用官方 Onsite Toolkit 的 onsiteImport
        命令，个人本人／团队队长的学号作为登录名，队名／姓名写入
        displayName。座位使用考场编号加序号（如 A01），未排座或未填编号时为空。
      </p>
      <p class="notice" v-else>
        包含
        groups.json、organizations.json、teams.json、accounts.json、账号密码表和说明。个人本人／团队队长的学号作为登录名，队伍与账号以报名
        ID 关联。按分组、学校、队伍、用户顺序在 Import / export 中导入。
      </p>
      <p>
        两个平台和准考证共用同一组学号与比赛密码；重复导出和重新生成准考证保持密码不变，与本站登录密码独立。<span
          v-if="platform === 'HYDRO'"
          >重新导入 Hydro 会重设远端密码。</span
        >导入包含明文比赛密码，请妥善保管。完成导出后仍需在目标平台导入，并核对比赛访问权限。
      </p>
      <p v-if="platform === 'HYDRO'">
        每次比赛清空 Hydro 后导入；本包不兼容旧账号或跨活动账号复用。队员只通过 members
        数组导入，正式／非正式性质使用布尔值 rank。
      </p>
      <p>资格撤销或报名删除后，请在目标平台手动处理原账号；新的导入包不会删除远端记录。</p>
      <div class="actions">
        <el-button type="primary" native-type="submit" :loading="busy" :disabled="!contestId"
          >导出平台导入包</el-button
        >
        <a href="https://albert-li-sz.github.io/NXOPA-RegSYS/#hydro" target="_blank" rel="noopener"
          >查看导入教程</a
        >
      </div>
    </el-form>
  </div>
</template>
<style scoped>
.platform-exports {
  max-width: 1000px;
}
.el-select {
  width: 100%;
}
p {
  line-height: 1.8;
}
</style>
