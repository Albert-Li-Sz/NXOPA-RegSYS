<script setup lang="ts">
import { ref } from 'vue';
import MarkdownContent from './MarkdownContent.vue';
const text = defineModel<string>({ required: true });
const format = defineModel<string>('format', { required: true });
const tab = ref('edit');
const tools = [
  ['标题', '## 标题'],
  ['列表', '- 列表项'],
  ['引用', '> 引用内容'],
  ['表格', '| 项目 | 说明 |\n| --- | --- |\n| 内容 | 内容 |'],
  ['代码', '```text\n代码内容\n```'],
  ['链接', '[链接文字](https://example.com)'],
  ['图片', '![图片说明](https://example.com/image.png)'],
];
function insert(value: string) {
  text.value += `\n\n${value}\n`;
}
</script>
<template>
  <div class="markdown-editor">
    <div class="toolbar">
      <el-radio-group v-model="format"
        ><el-radio-button value="TEXT">纯文本</el-radio-button
        ><el-radio-button value="MARKDOWN">Markdown</el-radio-button></el-radio-group
      ><el-radio-group v-if="format === 'MARKDOWN'" v-model="tab"
        ><el-radio-button value="edit">编辑</el-radio-button
        ><el-radio-button value="preview">预览</el-radio-button></el-radio-group
      >
    </div>
    <div v-if="format === 'MARKDOWN' && tab === 'edit'" class="markdown-tools">
      <el-button
        v-for="[title, value] in tools"
        :key="title"
        size="small"
        @click="insert(value!)"
        >{{ title }}</el-button
      >
    </div>
    <MarkdownContent
      v-if="format === 'MARKDOWN' && tab === 'preview'"
      :content="text"
      :format="format"
    />
    <el-input
      v-else
      v-model="text"
      type="textarea"
      :rows="9"
      aria-label="活动介绍"
      placeholder="介绍活动内容、参加要求和注意事项"
    />
  </div>
</template>
