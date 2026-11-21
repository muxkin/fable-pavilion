import { shallowRef } from 'vue';
import { watchRender } from '../render-effects';

const build = typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__ : '';
const installedAndroid = Number(/\bFablePavilionAndroid\/(\d+)\b/.exec(navigator.userAgent)?.[1] ?? 0);
const backgroundAndroid = /\bFablePavilionAndroidUpdater\b/.test(navigator.userAgent);
const androidPath = '/downloads/android/';
export type AndroidUpdateState = 'checking' | 'current' | 'downloading' | 'ready' | 'failed';

export interface AndroidRelease {
  version: string;
  versionCode: number;
  bytes: number;
  href: string;
}

export function refreshWebsite() {
  if ('serviceWorker' in navigator) {
    const prepare = installedAndroid
      ? navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => Promise.all(registrations.map((reg) => reg.unregister())))
      : navigator.serviceWorker.getRegistration().then((registration) => registration?.update());
    void prepare.catch(() => {}).finally(() => location.reload());
    return;
  }
  location.reload();
}

export function useSoftwareUpdates() {
  const website = shallowRef(false);
  const websiteBuildId = shallowRef('');
  const android = shallowRef<AndroidRelease | null>();
  const watchVersions = watchRender();
  const watchAndroid = watchRender();
  const nativeState = shallowRef<AndroidUpdateState>('checking');
  return (downloadsOpen: boolean) => {
    watchAndroid(() => {
      if (!backgroundAndroid) return;
      const source = window as Window & { fableAndroidUpdate?: AndroidUpdateState };
      const update = () => (nativeState.value = source.fableAndroidUpdate ?? 'checking');
      window.addEventListener('fable-android-update', update);
      update();
      return () => window.removeEventListener('fable-android-update', update);
    }, []);
    const checkAndroid = !!installedAndroid || downloadsOpen;
    watchVersions(() => {
      const controller = new AbortController();
      let checking = false;
      const read = async (path: string) => {
        const response = await fetch(path, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (response.ok) return response.json();
      };
      const check = async () => {
        if (checking || document.visibilityState !== 'visible') return;
        checking = true;
        try {
          const jobs = [
            read('/version.json').then((data) => {
              if (
                !controller.signal.aborted &&
                build &&
                typeof data?.buildId === 'string' &&
                /^[a-f0-9]{16}$/.test(data.buildId)
              ) {
                const updated = data.buildId !== build;
                website.value = updated;
                websiteBuildId.value = updated ? data.buildId : '';
              }
            }),
          ];
          if (checkAndroid)
            jobs.push(
              read(androidPath + 'latest.json')
                .then((data) => {
                  if (
                    controller.signal.aborted ||
                    typeof data?.version !== 'string' ||
                    !/^\d+\.\d+\.\d+$/.test(data.version) ||
                    !Number.isSafeInteger(data?.versionCode) ||
                    data.versionCode < 1 ||
                    !Number.isSafeInteger(data?.bytes) ||
                    data.bytes < 1
                  )
                    return;
                  android.value = {
                    version: data.version,
                    versionCode: data.versionCode,
                    bytes: data.bytes,
                    href: `${androidPath}fable-pavilion-android-${data.version}.apk`,
                  };
                })
                .finally(() => {
                  if (!controller.signal.aborted && android.value === undefined) android.value = null;
                }),
            );
          // Keep the last successful read during transient network errors.
          await Promise.allSettled(jobs);
        } finally {
          checking = false;
        }
      };
      void check();
      const timer = window.setInterval(check, 60_000);
      window.addEventListener('focus', check);
      window.addEventListener('online', check);
      document.addEventListener('visibilitychange', check);
      return () => {
        controller.abort();
        window.clearInterval(timer);
        window.removeEventListener('focus', check);
        window.removeEventListener('online', check);
        document.removeEventListener('visibilitychange', check);
      };
    }, [checkAndroid]);
    const release = android.value;
    return {
      website: website.value,
      websiteBuildId: websiteBuildId.value,
      android: release,
      androidAvailable: backgroundAndroid
        ? nativeState.value === 'ready'
        : !!installedAndroid && !!release && release.versionCode > installedAndroid,
      androidUpdateState: backgroundAndroid ? nativeState.value : undefined,
    };
  };
}
