<script setup lang="ts">
const renderedAt = new Date().toISOString();
</script>

<template>
  <div>
    <NuxtRouteAnnouncer />
    <h1>Nuxt on OpsCrew</h1>
    <p>Rendered on the server at {{ renderedAt }}.</p>
  </div>
</template>
