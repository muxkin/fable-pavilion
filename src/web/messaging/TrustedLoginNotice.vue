<script setup lang="ts">
import { shallowRef, watch } from 'vue';
import { useMessaging } from './context';
import { trustedDevices, trustedLoginEventLabels, type TrustedLoginEvent } from '../trusted-login';

const props = defineProps<{ openSecurity: () => void }>();
const session = useMessaging();
const activity = shallowRef<TrustedLoginEvent>();
let seen = '';
let storageKey = '';

function dismiss() {
  if (!activity.value) return;
  seen = activity.value.id;
  try {
    localStorage.setItem(storageKey, seen);
  } catch {}
  activity.value = undefined;
}

watch(
  () => (session.user?.encrypted ? session.user.id : undefined),
  (id, _, cleanup) => {
    activity.value = undefined;
    if (!id) return;
    storageKey = `pocket-security-seen:${id}`;
    seen = '';
    try {
      seen = localStorage.getItem(storageKey) || '';
    } catch {}
    const abort = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden || abort.signal.aborted) return;
      pending = true;
      try {
        const { events } = await trustedDevices(abort.signal);
        const latest = events?.[0];
        if (
          !abort.signal.aborted &&
          latest &&
          latest.id !== seen &&
          Date.now() - latest.createdAt < 24 * 60 * 60 * 1000
        )
          activity.value = latest;
      } catch {
        // The security history is still available when the connection returns.
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    cleanup(() => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    });
  },
  { immediate: true },
);
</script>

<template>
  <aside v-if="activity" class="security-notice" aria-label="账号安全通知">
    <span role="status">{{ trustedLoginEventLabels[activity.kind] }}</span>
    <button
      type="button"
      @click="
        dismiss();
        props.openSecurity();
      "
    >
      查看
    </button>
    <button type="button" @click="dismiss">关闭</button>
  </aside>
</template>

<style scoped>
.security-notice {
  position: absolute;
  inset: 12px 12px auto auto;
  z-index: 15;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  max-width: calc(100% - 24px);
  padding: 5px 8px 5px 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-raised);
  color: var(--ink);
  box-shadow: 0 4px 18px var(--shadow);
}
.security-notice button {
  min-height: 40px;
  padding-inline: 8px;
  color: var(--accent);
}
</style>
