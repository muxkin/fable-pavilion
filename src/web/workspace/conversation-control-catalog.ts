import { shallowRef } from 'vue';
import type { BackendInfo } from '../../shared/backends';
import type { ControlCatalog, ControlState } from '../../shared/controls';
import { deviceSession } from '../device-session';
import { watchRender } from '../render-effects';

interface CatalogSnapshot {
  key: string;
  value?: ControlCatalog;
  loading: boolean;
  error?: string;
}

export function useConversationControlCatalog() {
  const snapshot = shallowRef<CatalogSnapshot>();
  const manualRefresh = shallowRef(0);
  const reload = () => manualRefresh.value++;
  const watchCatalog = watchRender();

  return (options: {
    backendId: string;
    backend?: BackendInfo;
    deviceId: string;
    threadId?: string;
    connected: boolean;
    state?: ControlState;
    refresh: string;
    turnId?: string | null;
  }) => {
    const { backendId, backend, deviceId, threadId, connected, state, refresh, turnId } = options;
    const key = JSON.stringify([deviceId, backendId, threadId]);
    const current = snapshot.value?.key === key ? snapshot.value : undefined;
    const retry = manualRefresh.value;
    watchCatalog(() => {
      if (!threadId || !connected) return;
      const controller = new AbortController();
      let reading = false;
      const read = async (background = false) => {
        if (reading || controller.signal.aborted) return;
        reading = true;
        const previous = snapshot.value?.key === key ? snapshot.value : undefined;
        if (!background) snapshot.value = { key, value: previous?.value, loading: true };
        try {
          const value = await deviceSession.api<ControlCatalog>(
            `/threads/${encodeURIComponent(threadId)}/controls`,
            { signal: controller.signal },
            backendId,
          );
          if (!controller.signal.aborted) snapshot.value = { key, value, loading: false };
        } catch (error) {
          if (!background && !controller.signal.aborted)
            snapshot.value = {
              key,
              value: previous?.value,
              loading: false,
              error: error instanceof Error ? error.message : '暂时无法读取会话控制',
            };
        } finally {
          reading = false;
        }
      };
      const refreshGoal = () => {
        const catalog = snapshot.value?.value;
        if (
          document.visibilityState === 'visible' &&
          catalog?.product === 'codex' &&
          (catalog.goal !== undefined || catalog.actions.includes('goal') || catalog.goalUnavailableReason)
        )
          void read(true);
      };
      void read();
      const goalPoll = setInterval(refreshGoal, 15000);
      document.addEventListener('visibilitychange', refreshGoal);
      return () => {
        controller.abort();
        clearInterval(goalPoll);
        document.removeEventListener('visibilitychange', refreshGoal);
      };
    }, [
      key,
      connected,
      state?.permission,
      state?.permissionRevision,
      state?.goalRevision,
      state?.preset,
      state?.plan,
      backend?.connected,
      backend?.version,
      JSON.stringify([backend?.capabilities, backend?.presentation]),
      refresh,
      turnId,
      retry,
    ]);
    return {
      catalog: current?.value,
      catalogLoading: !current || current.loading,
      catalogError: current?.error,
      reload,
    };
  };
}
