<script setup lang="ts">
import ContestCatalogue from '../components/ContestCatalogue.vue';
import { useContests } from '../composables/useContests';
const { contests, loading, error, load } = useContests();
</script>
<template>
  <ContestCatalogue :contests="contests" :loading="loading" :error="error" @retry="load" />
</template>
