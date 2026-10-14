<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ElMessageBox } from 'element-plus';
import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ src: string }>();
const canvas = ref<HTMLCanvasElement>(),
  viewport = ref<HTMLElement>(),
  pageNumber = ref(1),
  pageCount = ref(0),
  zoom = ref(1),
  loading = ref(false),
  rendering = ref(false),
  ready = ref(false),
  error = ref('');
let pdf: PDFDocumentProxy | undefined,
  loader: PDFDocumentLoadingTask | undefined,
  renderer: RenderTask | undefined,
  resize: ResizeObserver | undefined,
  resizeTimer: ReturnType<typeof setTimeout>,
  loadSequence = 0,
  renderSequence = 0,
  width = 0;
async function draw() {
  if (!pdf || !canvas.value || !viewport.value) return;
  const sequence = ++renderSequence,
    document = pdf,
    previous = renderer;
  renderer = undefined;
  ready.value = false;
  rendering.value = true;
  previous?.cancel();
  try {
    if (previous) await previous.promise.catch(() => {});
    const page = await document.getPage(pageNumber.value);
    if (sequence !== renderSequence) return;
    const base = page.getViewport({ scale: 1 }),
      available = Math.max(100, viewport.value.clientWidth - 32),
      scaled = page.getViewport({ scale: (available / base.width) * zoom.value }),
      density = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(16000000 / (scaled.width * scaled.height)),
      );
    const element = canvas.value;
    element.width = Math.max(1, Math.floor(scaled.width * density));
    element.height = Math.max(1, Math.floor(scaled.height * density));
    element.style.width = `${Math.floor(scaled.width)}px`;
    element.style.height = `${Math.floor(scaled.height)}px`;
    const task = page.render({
      canvas: element,
      viewport: scaled,
      transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
    });
    renderer = task;
    await task.promise;
    if (sequence === renderSequence) ready.value = true;
  } catch (failure) {
    if (sequence === renderSequence && (failure as Error)?.name !== 'RenderingCancelledException')
      error.value = 'PDF 页面显示失败，请重新预览或下载查看';
  } finally {
    if (sequence === renderSequence) rendering.value = false;
  }
}
async function load() {
  const sequence = ++loadSequence;
  renderSequence++;
  renderer?.cancel();
  const previous = loader;
  loader = undefined;
  pdf = undefined;
  pageCount.value = 0;
  ready.value = false;
  loading.value = true;
  error.value = '';
  pageNumber.value = 1;
  zoom.value = 1;
  try {
    await previous?.destroy().catch(() => {});
    if (sequence !== loadSequence) return;
    const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
    const task = getDocument({
      url: props.src,
      cMapUrl: assets + 'cmaps/',
      standardFontDataUrl: assets + 'standard_fonts/',
      wasmUrl: assets + 'wasm/',
      iccUrl: assets + 'iccs/',
    });
    loader = task;
    task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
      if (sequence !== loadSequence) return;
      ElMessageBox.prompt(
        reason === PasswordResponses.INCORRECT_PASSWORD
          ? '密码不正确，请重新输入'
          : '此 PDF 已加密，请输入文档密码',
        'PDF 密码',
        { inputType: 'password', confirmButtonText: '打开 PDF', cancelButtonText: '取消' },
      )
        .then(({ value }) => {
          if (sequence === loadSequence) updatePassword(value);
        })
        .catch(() => {
          if (sequence === loadSequence) {
            error.value = '已取消输入密码，可关闭后重新预览';
            void task.destroy().catch(() => {});
          }
        });
    };
    const result = await task.promise;
    if (sequence !== loadSequence) return;
    pdf = result;
    pageCount.value = result.numPages;
    await nextTick();
    await draw();
  } catch {
    if (sequence === loadSequence && !error.value)
      error.value = 'PDF 无法打开，请确认文件完整后重试';
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}
watch(() => props.src, load, { immediate: true });
watch([pageNumber, zoom], () => {
  if (pdf) {
    error.value = '';
    void draw();
  }
});
onMounted(() => {
  resize = new ResizeObserver(([entry]) => {
    if (!entry || Math.abs(entry.contentRect.width - width) < 1) return;
    width = entry.contentRect.width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdf) void draw();
    }, 100);
  });
  if (viewport.value) resize.observe(viewport.value);
});
onBeforeUnmount(() => {
  loadSequence++;
  renderSequence++;
  resize?.disconnect();
  clearTimeout(resizeTimer);
  renderer?.cancel();
  void loader?.destroy().catch(() => {});
});
</script>
<template>
  <div class="pdf-preview">
    <div class="pdf-controls button-group">
      <el-button :disabled="loading || rendering || pageNumber <= 1" @click="pageNumber--"
        >上一页</el-button
      >
      <span aria-live="polite">第 {{ pageNumber }} / {{ pageCount }} 页</span>
      <el-button :disabled="loading || rendering || pageNumber >= pageCount" @click="pageNumber++"
        >下一页</el-button
      >
      <el-button
        aria-label="缩小 PDF"
        :disabled="loading || rendering || zoom <= 0.5"
        @click="zoom = Math.max(0.5, zoom - 0.25)"
        >缩小</el-button
      >
      <span>{{ Math.round(zoom * 100) }}%</span>
      <el-button
        aria-label="放大 PDF"
        :disabled="loading || rendering || zoom >= 2.5"
        @click="zoom = Math.min(2.5, zoom + 0.25)"
        >放大</el-button
      >
      <el-button :disabled="loading || rendering" @click="zoom = 1">适应宽度</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div ref="viewport" class="pdf-viewport" v-loading="loading || rendering">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="`PDF 第 ${pageNumber} 页`"
        :data-rendered="ready"
        v-show="pageCount > 0"
      />
    </div>
  </div>
</template>
<style scoped>
.pdf-controls {
  margin-bottom: 12px;
  font-size: 14px;
  color: #606266;
}
.pdf-viewport {
  height: 60vh;
  min-height: 250px;
  overflow: auto;
  padding: 16px;
  background: #f5f7fa;
  border: 1px solid #ebeef2;
  border-radius: 8px;
}
.pdf-viewport canvas {
  display: block;
  margin: auto;
  background: #fff;
  box-shadow: 0 2px 6px #1f293714;
}
</style>
