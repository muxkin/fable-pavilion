<script setup lang="ts">
import { appIconPath } from './app-icons';
import { useAppearance } from './use-appearance';

defineProps<{ size: number }>();
const appearance = useAppearance();
</script>

<template>
  <img :src="appIconPath(appearance.settings.appIcon)" alt="" :width="size" :height="size" />
</template>
