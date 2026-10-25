<script setup lang="ts">
import PaginatedTable from './PaginatedTable.vue';
import PaginatedList from './PaginatedList.vue';
import { ref, onMounted, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import type { Data } from '../types';
import { useEditSession } from '../composables/useEditSession';
import EditActions from './EditActions.vue';
const props = defineProps<{ contestId: string }>();
const data = ref<Data>({ rooms: [], seats: [], examSites: [], seatingVersion: 1 }),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  planError = ref(''),
  dialog = ref(false),
  room = ref<Data>({}),
  preview = ref<Data>(),
  request = ref<Data>(),
  planOpen = ref(false),
  replace = ref(false),
  range = ref('ALL'),
  selected = ref<string[]>([]),
  candidates = ref<Data[]>([]),
  importFile = ref('');
const roomEdit = useEditSession(room);
const manualOpen = ref(false),
  manualRows = ref<Data[]>([]);
async function load() {
  loading.value = true;
  try {
    data.value = await api(`/contests/${props.contestId}/rooms`);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
function editRoom(row?: Data) {
  room.value = row
    ? JSON.parse(JSON.stringify(row))
    : {
        name: '',
        code: '',
        location: '',
        examSiteId: null,
        capacity: 30,
        sortOrder: 0,
        enabled: true,
      };
  dialog.value = true;
  if (row) roomEdit.finish();
  else roomEdit.begin();
}
async function saveRoom() {
  busy.value = true;
  try {
    await api(
      `/contests/${props.contestId}/rooms${room.value.id ? `/${room.value.id}` : ''}`,
      room.value.id ? 'PUT' : 'POST',
      room.value,
    );
    roomEdit.finish();
    dialog.value = false;
    await load();
  } finally {
    busy.value = false;
  }
}
async function deleteRoom(row: Data) {
  await ElMessageBox.confirm(`确认删除考场 ${row.name}？有座位的考场需先清空。`, '删除考场', {
    type: 'warning',
  });
  await api(`/contests/${props.contestId}/rooms/${row.id}`, 'DELETE', { version: row.version });
  await load();
}
async function clear(roomId?: string) {
  await ElMessageBox.confirm('清空排考会使受影响准考证失效，确认继续？', '清空排考', {
    type: 'warning',
  });
  await api(`/contests/${props.contestId}/seating/clear`, 'POST', {
    seatingVersion: data.value.seatingVersion,
    roomId,
  });
  await load();
}
async function loadCandidates() {
  candidates.value = [];
  let page = 1,
    total = 1;
  while (candidates.value.length < total) {
    const result = await api(
      `/registrations?contestId=${props.contestId}&eligible=true&page=${page++}&pageSize=100`,
    );
    candidates.value.push(...result.items);
    total = result.total;
    if (!result.items.length) break;
  }
  selected.value = [];
  preview.value = undefined;
  request.value = undefined;
  planError.value = '';
  importFile.value = '';
}
async function openPlan() {
  await loadCandidates();
  planOpen.value = true;
}
const chosen = computed(() =>
  range.value === 'SELECTED' ? selected.value : candidates.value.map((r) => r.id),
);
async function showPreview(assignments?: Data[]) {
  if (busy.value) return false;
  if (!chosen.value.length && !assignments?.length) {
    ElMessage.warning('请先选择报名');
    return false;
  }
  busy.value = true;
  preview.value = undefined;
  request.value = undefined;
  planError.value = '';
  try {
    const body = {
      registrationIds: assignments
        ? [...new Set(assignments.map((a) => a.registrationId))]
        : chosen.value,
      replace: assignments ? true : replace.value,
      ...(assignments ? { assignments } : {}),
    };
    preview.value = await api(`/contests/${props.contestId}/seating/preview`, 'POST', body);
    request.value = body;
    return true;
  } catch (e) {
    planError.value = (e as Error).message;
    return false;
  } finally {
    busy.value = false;
  }
}
async function commit() {
  if (busy.value || !preview.value || !request.value || preview.value.errors.length) return;
  busy.value = true;
  try {
    await api(`/contests/${props.contestId}/seating/commit`, 'POST', {
      ...request.value,
      seatingVersion: preview.value.seatingVersion,
      registrationVersions: preview.value.registrationVersions,
    });
    ElMessage.success('排考已保存');
    planOpen.value = false;
    await load();
  } catch (e) {
    planError.value = `${(e as Error).message}，请重新预览后确认。`;
    preview.value = undefined;
    request.value = undefined;
  } finally {
    busy.value = false;
  }
}
function csvRows(raw: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (quoted && raw[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(cell.trim());
      cell = '';
      if (ch === '\n') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else if (ch !== '\r') cell += ch;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error('CSV 引号未闭合');
  return rows;
}
async function importCsv(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    await loadCandidates();
    const rows = csvRows((await file.text()).replace(/^\uFEFF/, ''));
    const header = rows.shift();
    const byName = header?.join(',') === 'registrationId,personId,room,seat';
    if (!byName && header?.join(',') !== 'registrationId,personId,roomId,seat')
      throw new Error('请使用下载的排考模板：registrationId,personId,room,seat');
    importFile.value = file.name;
    const shown = await showPreview(
      rows.map(([registrationId, personId, roomId, seat]) => ({
        registrationId,
        personId: personId || null,
        roomId: byName
          ? data.value.rooms.find(
              (r: Data) => r.name === roomId || r.name === roomId?.replace(/^'(?=[=+\-@])/, ''),
            )?.id || ''
          : roomId,
        seat: Number(seat),
      })),
    );
    planOpen.value = shown;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    input.value = '';
  }
}
async function downloadCsv() {
  await loadCandidates();
  const rows: unknown[][] = [['registrationId', 'personId', 'room', 'seat']];
  const seats = new Map(
    data.value.seats.map((a: Data) => [`${a.registrationId}:${a.personId || ''}`, a]),
  );
  for (const r of candidates.value) {
    for (const person of data.value.seatingMode === 'PERSON' ? r.people : [{ id: null }]) {
      const existing = seats.get(`${r.id}:${person.id || ''}`) as Data | undefined;
      rows.push([r.id, person.id || '', existing?.room.name || '', existing?.seat || '']);
    }
  }
  const csv =
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map(
            (v) =>
              `"${(/^[=+\-@\t\r]/.test(String(v ?? '')) ? "'" + String(v ?? '') : String(v ?? '')).replaceAll('"', '""')}"`,
          )
          .join(','),
      )
      .join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    link = document.createElement('a');
  link.href = url;
  link.download = '排考导入模板.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function setupManual() {
  if (!chosen.value.length) {
    ElMessage.warning('请先选择报名');
    return;
  }
  const units: Data[] = [];
  for (const r of candidates.value.filter((r) => chosen.value.includes(r.id))) {
    const people =
      data.value.seatingMode === 'PERSON'
        ? r.people
        : [{ id: null, name: r.teamName || r.people[0]?.name }];
    for (const p of people) {
      const old = data.value.seats.find(
        (a: Data) => a.registrationId === r.id && (a.personId || null) === (p.id || null),
      );
      units.push({
        registrationId: r.id,
        personId: p.id || null,
        name: p.name,
        examSiteId: r.examSiteId,
        roomId:
          old?.roomId ||
          data.value.rooms.find(
            (room: Data) => room.enabled && (!r.examSiteId || room.examSiteId === r.examSiteId),
          )?.id ||
          '',
        seat: old?.seat || 1,
      });
    }
  }
  manualRows.value = units;
  manualOpen.value = true;
}
async function manual(row: Data) {
  await loadCandidates();
  selected.value = [row.registrationId];
  range.value = 'SELECTED';
  replace.value = true;
  setupManual();
}
async function previewManual() {
  const shown = await showPreview(
    manualRows.value.map(({ registrationId, personId, roomId, seat }) => ({
      registrationId,
      personId,
      roomId,
      seat,
    })),
  );
  if (!shown) return;
  manualOpen.value = false;
  planOpen.value = true;
  importFile.value = '手动排考';
}
async function closeRoom(done: () => void) {
  if (busy.value) return;
  if (await roomEdit.mayLeave()) {
    roomEdit.cancel();
    done();
  }
}
</script>
<template>
  <el-alert v-if="error" :title="error" type="error" />
  <div class="card" v-loading="loading">
    <div class="page-heading">
      <div>
        <h3>考场与座位</h3>
        <p class="form-help">
          {{ data.seatingMode === 'PERSON' ? '每位成员一座，同队同场' : '每份报名一座' }}。座位从 1
          开始，调整后需重新生成准考证。
        </p>
      </div>
      <div class="actions">
        <el-button @click="load">刷新</el-button
        ><el-button type="primary" @click="editRoom()">新增考场</el-button>
      </div>
    </div>
    <PaginatedTable page-key="seatingmanager-data-rooms" :data="data.rooms"
      ><el-table-column prop="name" label="考场" /><el-table-column
        prop="code"
        label="考场编号"
      /><el-table-column v-if="data.examSites.length" label="所属考点"
        ><template #default="{ row }">{{
          row.examSite?.name || '未关联'
        }}</template></el-table-column
      ><el-table-column prop="location" label="地点" /><el-table-column
        prop="capacity"
        label="容量"
        width="90"
      /><el-table-column label="已安排" width="90"
        ><template #default="{ row }">{{
          data.seats.filter((a: Data) => a.roomId === row.id).length
        }}</template></el-table-column
      ><el-table-column prop="sortOrder" label="顺序" width="80" /><el-table-column
        label="状态"
        width="90"
        ><template #default="{ row }">{{
          row.enabled ? '启用' : '停用'
        }}</template></el-table-column
      ><el-table-column label="操作" width="200"
        ><template #default="{ row }"
          ><el-button text @click="editRoom(row)">修改及查看</el-button
          ><el-button text @click="clear(row.id)">清空</el-button
          ><el-button text type="danger" @click="deleteRoom(row)">删除</el-button></template
        ></el-table-column
      ></PaginatedTable
    >
    <div class="toolbar" style="margin-top: 20px">
      <el-button type="primary" @click="openPlan">自动排考预览</el-button
      ><el-button @click="downloadCsv">下载排考模板</el-button
      ><label class="upload-label"
        >导入排考 CSV<input type="file" accept=".csv" @change="importCsv" /></label
      ><el-button type="danger" plain @click="clear()">清空全部排考</el-button>
    </div>
    <p class="form-help">
      下载模板后填写考场名称和座位号，保留报名和成员编号；一队一座时成员编号留空。导入先预览，确认后整体写入。
    </p>
    <PaginatedTable page-key="seatingmanager-data-seats" :data="data.seats"
      ><el-table-column label="报名"
        ><template #default="{ row }"
          >#{{ row.registration.number }} ·
          {{ row.registration.teamName || row.registration.people[0]?.name }}</template
        ></el-table-column
      ><el-table-column label="成员"
        ><template #default="{ row }">{{
          row.personId
            ? row.registration.people.find((p: Data) => p.id === row.personId)?.name ||
              '成员已变更，需重新排考'
            : '全队／个人'
        }}</template></el-table-column
      ><el-table-column label="考场"
        ><template #default="{ row }">{{ row.room.name }}</template></el-table-column
      ><el-table-column prop="seat" label="座位" /><el-table-column label="操作"
        ><template #default="{ row }"
          ><el-button text @click="manual(row)">调整座位</el-button></template
        ></el-table-column
      ></PaginatedTable
    >
  </div>
  <el-dialog
    v-model="dialog"
    :title="room.id ? '考场详情' : '新增考场'"
    width="620px"
    :before-close="closeRoom"
    :show-close="!busy"
    ><EditActions :session="roomEdit" :allow="!busy" /><el-form
      :key="String(roomEdit.editing.value)"
      label-position="top"
      :disabled="!roomEdit.editing.value || busy"
      :class="{ 'read-mode': !roomEdit.editing.value }"
      @submit.prevent="saveRoom"
      ><el-form-item label="考场名称"><el-input v-model="room.name" /></el-form-item
      ><el-form-item label="考场编号" for="room-code">
        <el-input
          id="room-code"
          v-model="room.code"
          maxlength="20"
          placeholder="例如 A、B；留空时 Hydro 导出空座位"
        />
        <p class="form-help">
          可选，支持字母、数字、下划线和连字符，保存后统一为大写，同一活动内不可重复。Hydro
          座位示例：A01。
        </p> </el-form-item
      ><el-form-item v-if="data.examSites.length" label="所属考点" required for="room-exam-site">
        <el-select
          id="room-exam-site"
          v-model="room.examSiteId"
          filterable
          placeholder="选择所属考点"
        >
          <el-option
            v-for="site in data.examSites"
            :key="site.id"
            :value="site.id"
            :label="site.name + (site.enabled ? '' : '（已停用选择）')"
          />
        </el-select> </el-form-item
      ><el-form-item label="地点"><el-input v-model="room.location" /></el-form-item
      ><el-form-item label="容量"
        ><el-input-number v-model="room.capacity" :min="1" :max="10000" /></el-form-item
      ><el-form-item label="分配顺序"><el-input-number v-model="room.sortOrder" /></el-form-item
      ><el-form-item label="启用"><el-switch v-model="room.enabled" /></el-form-item
      ><el-button v-if="roomEdit.editing.value" type="primary" native-type="submit" :loading="busy"
        >保存考场</el-button
      ></el-form
    ></el-dialog
  >
  <el-dialog
    v-model="planOpen"
    title="排考预览与确认"
    width="min(1000px,95vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    ><template v-if="!importFile"
      ><el-radio-group v-model="range" :disabled="busy" @change="preview = undefined"
        ><el-radio value="ALL">全部取得资格的报名（{{ candidates.length }} 份）</el-radio
        ><el-radio value="SELECTED">仅已勾选（{{ selected.length }} 份）</el-radio></el-radio-group
      ><PaginatedTable
        page-key="seatingmanager-candidates"
        v-if="range === 'SELECTED'"
        :data="candidates"
        max-height="230"
        @selection-change="
          (rows: Data[]) => {
            selected = rows.map((r) => r.id);
            preview = undefined;
          }
        "
        ><el-table-column
          reserve-selection
          type="selection"
          :selectable="() => !busy"
        /><el-table-column label="报名"
          ><template #default="{ row }"
            >#{{ row.number }} {{ row.teamName || row.people[0]?.name }}</template
          ></el-table-column
        ><el-table-column v-if="data.examSites.length" label="考点"
          ><template #default="{ row }">{{
            row.examSite?.name || '未选择'
          }}</template></el-table-column
        ></PaginatedTable
      >
      <div class="toolbar">
        <el-checkbox v-model="replace" :disabled="busy" @change="preview = undefined"
          >重新分配所选报名（替换已有座位）</el-checkbox
        ><el-button :loading="busy" @click="showPreview()">预览分配结果</el-button
        ><el-button :disabled="busy" @click="setupManual">手动填写座位</el-button>
      </div></template
    >
    <p v-else>导入文件：{{ importFile }}</p>
    <el-alert v-if="planError" :title="planError" type="error" :closable="false" />
    <template v-if="preview"
      ><p>
        本次作用范围：{{ preview.total }} 份报名；新增／替换
        {{ preview.assignments.length }} 个座位。
      </p>
      <PaginatedList
        :items="preview.errors"
        page-key="seating-preview-errors"
        :always="false"
        v-slot="{ items }"
      >
        <el-alert
          v-for="(message, index) in items"
          :key="index"
          :title="message"
          type="error"
          :closable="false" /></PaginatedList
      ><PaginatedTable
        page-key="seatingmanager-preview-assignments"
        :data="preview.assignments"
        max-height="400"
        ><el-table-column prop="number" label="报名编号" /><el-table-column
          prop="name"
          label="姓名" /><el-table-column prop="roomName" label="考场" /><el-table-column
          prop="seat"
          label="座位" /></PaginatedTable></template
    ><template #footer
      ><el-button :disabled="busy" @click="planOpen = false">关闭</el-button
      ><el-button
        type="primary"
        :disabled="busy || !preview || preview.errors.length > 0"
        :loading="busy"
        @click="commit"
        >确认保存本次排考</el-button
      ></template
    ></el-dialog
  >
  <el-dialog
    v-model="manualOpen"
    title="手动安排座位"
    width="min(900px,95vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    ><p class="form-help">每个座位填写完成后先预览；同队按成员排考时请安排在同一考场。</p>
    <el-alert v-if="planError" :title="planError" type="error" :closable="false" />
    <PaginatedTable page-key="seatingmanager-manualrows" :data="manualRows"
      ><el-table-column prop="name" label="姓名／队伍" /><el-table-column
        label="考场"
        min-width="220"
        ><template #default="{ row }"
          ><el-select v-model="row.roomId" filterable :disabled="busy"
            ><el-option
              v-for="item in data.rooms.filter(
                (r: Data) => r.enabled && (!row.examSiteId || r.examSiteId === row.examSiteId),
              )"
              :key="item.id"
              :label="`${item.name} · ${item.location}`"
              :value="item.id" /></el-select></template></el-table-column
      ><el-table-column label="座位号" min-width="160"
        ><template #default="{ row }"
          ><el-input-number
            v-model="row.seat"
            :disabled="busy"
            :min="1"
            :max="
              data.rooms.find((room: Data) => room.id === row.roomId)?.capacity || 1
            " /></template></el-table-column></PaginatedTable
    ><template #footer
      ><el-button :disabled="busy" @click="manualOpen = false">取消</el-button
      ><el-button type="primary" :loading="busy" @click="previewManual"
        >预览手动排考</el-button
      ></template
    ></el-dialog
  >
</template>
