<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>
<template>
  <el-empty description="页面不存在"
    ><el-button :tag="RouterLink" to="/" type="primary">返回竞赛列表</el-button></el-empty
  >
</template>
