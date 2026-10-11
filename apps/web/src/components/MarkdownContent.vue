<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
const props = withDefaults(defineProps<{ content: string; format?: string }>(), { format: 'TEXT' });
const renderer = new MarkdownIt({ html: false, linkify: true, breaks: true });
const html = computed(() =>
  DOMPurify.sanitize(renderer.render(props.content), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['style'],
  }),
);
</script>
<template>
  <div v-if="format === 'MARKDOWN'" class="markdown-content" v-html="html" />
  <div v-else class="pre-line">{{ content }}</div>
</template>
