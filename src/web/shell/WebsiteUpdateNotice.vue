<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { refreshWebsite } from './software-updates';

const props = defineProps<{
  available: boolean;
  buildId: string;
  blocked: boolean;
  hidden?: boolean;
}>();

const dismissedBuildId = shallowRef('');
const visible = computed(
  () => props.available && !props.hidden && dismissedBuildId.value !== (props.buildId || 'pending'),
);

function dismiss() {
  dismissedBuildId.value = props.buildId || 'pending';
}
</script>

<template>
  <aside v-if="visible" class="website-update-notice" aria-label="网页版本更新提示">
    <span role="status">
      {{ blocked ? '发现新版本，刷新会中断当前上传或语音' : '发现新版本，刷新即可生效' }}
    </span>
    <div class="website-update-actions">
      <button type="button" class="website-update-primary" @click="refreshWebsite">
        立即刷新
      </button>
      <button type="button" class="website-update-dismiss" @click="dismiss">稍后</button>
    </div>
  </aside>
</template>

<style scoped>
.website-update-notice {
  position: absolute;
  inset: 12px 12px auto auto;
  z-index: 16;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  max-width: calc(100% - 24px);
  padding: 6px 10px 6px 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-raised);
  color: var(--ink);
  box-shadow: 0 4px 18px var(--shadow);
  font-size: 13px;
}
.website-update-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.website-update-primary {
  min-height: 34px;
  padding: 0 12px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.website-update-primary:disabled {
  opacity: 0.55;
  cursor: default;
}
.website-update-dismiss {
  min-height: 34px;
  padding-inline: 8px;
  color: var(--muted);
}
@media (max-width: 700px) {
  .website-update-notice {
    inset: max(10px, env(safe-area-inset-top)) 12px auto 12px;
    justify-content: space-between;
  }
}
</style>
