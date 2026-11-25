<script setup lang="ts">
import { computed, onUnmounted, shallowRef } from 'vue';
import {
  linuxMuslInstallerTarget,
  nativeInstallerTargets,
  type NativeInstallerTarget,
} from '../../shared/desktop-releases.js';
import SvgIcon from '../SvgIcon.vue';
import { loadNativeInstaller, nativeSourceArchive, type NativeInstaller } from './native-installers.js';
import { refreshWebsite, type AndroidRelease, type AndroidUpdateState } from './software-updates';
import { usePwaInstall } from '../pwa-install';

const pwaInstall = usePwaInstall();

const props = defineProps<{
  websiteUpdate: boolean;
  androidRelease?: AndroidRelease | null;
  androidUpdate: boolean;
  androidUpdateState?: AndroidUpdateState;
  androidUpdateProgress?: number | null;
  updateBlocked: boolean;
}>();

const installerLabels = {
  'windows-x64-setup.exe': { name: 'Windows x64', icon: 'windows', format: 'EXE' },
  'macos-arm64.dmg': { name: 'macOS Apple Silicon', icon: 'apple', format: 'DMG' },
  'macos-x64.dmg': { name: 'macOS Intel', icon: 'apple', format: 'DMG' },
  'linux-x64.deb': { name: 'Linux x64（glibc）', icon: 'linux', format: 'DEB' },
  'linux-x64-musl-desktop.tar.zst': { name: 'Linux x64（musl）', icon: 'linux', format: 'TAR.ZST' },
} as const;

type NativeResult = NativeInstaller | 'loading' | 'unpublished' | 'error';
type InstallerSuffix = NativeInstallerTarget['suffix'];
const nativeResults = shallowRef<Partial<Record<InstallerSuffix, NativeResult>>>({});
const targets = [...nativeInstallerTargets, linuxMuslInstallerTarget];
const nativeRows = computed(() =>
  targets
    .map((target) => ({
      target,
      ...installerLabels[target.suffix],
      result: nativeResults.value[target.suffix] ?? 'loading',
    }))
    .filter(({ target, result }) => target !== linuxMuslInstallerTarget || result !== 'unpublished'),
);
const verifiedRows = computed(() =>
  nativeRows.value.flatMap(({ name, result }) =>
    typeof result === 'string' ? [] : [{ name, release: result }],
  ),
);
const sourceArchive = computed(() => nativeSourceArchive(verifiedRows.value.map(({ release }) => release)));
const checkingInstallers = computed(() => nativeRows.value.some(({ result }) => result === 'loading'));
const installerRequests = new AbortController();
const sizeLabel = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MiB`;
const androidStatus: Record<AndroidUpdateState, string> = {
  checking: '正在检查更新…',
  current: '已是最新版本',
  downloading: '正在后台下载…',
  ready: '已下载，可安装',
  failed: '暂时无法获取更新',
};
const androidStatusText = computed(() => {
  const state = props.androidUpdateState;
  if (!state) return '';
  if (state === 'downloading' && typeof props.androidUpdateProgress === 'number') {
    return `正在下载更新（${props.androidUpdateProgress}%）…`;
  }
  return androidStatus[state];
});

function checkInstaller(target: NativeInstallerTarget) {
  const { signal } = installerRequests;
  const setResult = (result: NativeResult) => {
    if (!signal.aborted) {
      nativeResults.value = { ...nativeResults.value, [target.suffix]: result };
    }
  };
  setResult('loading');
  void loadNativeInstaller(target, 'rust', signal)
    .then((release) => setResult(release ?? 'unpublished'))
    .catch(() => setResult('error'));
}

for (const target of targets) checkInstaller(target);
onUnmounted(() => installerRequests.abort());
</script>

<template>
  <div class="adapter-downloads">
    <section v-if="websiteUpdate" class="software-update" aria-labelledby="website-update-title">
      <div class="installer-info">
        <strong id="website-update-title">网页有更新</strong>
        <small>{{ updateBlocked ? '当前有正在进行的上传或语音，仍可直接刷新。' : '刷新后使用最新页面，不影响电脑端任务执行。' }}</small>
      </div>
      <button type="button" class="installer-download" @click="refreshWebsite">
        刷新页面
      </button>
    </section>

    <section class="mobile-installer" aria-labelledby="android-installer-title">
      <div class="installer-heading">
        <h2 id="android-installer-title">手机应用</h2>
      </div>
      <ul class="installer-list">
        <li class="installer-row">
          <span class="platform-icon"><SvgIcon name="phone" :size="22" /></span>
          <div class="installer-info">
            <strong>Android</strong>
            <small v-if="androidUpdateState" aria-live="polite">{{ androidStatusText }}</small>
            <small v-else-if="androidRelease">
              v{{ androidRelease.version }} · APK · {{ Math.ceil(androidRelease.bytes / 1024) }} KiB
            </small>
            <small v-else-if="androidRelease === null">暂时无法读取安装包</small>
          </div>
          <a v-if="androidUpdateState" class="installer-download" href="fable-pavilion://android-update">
            {{ androidUpdateState === 'ready' ? '安装更新' : '检查更新' }}
          </a>
          <a
            v-else-if="androidRelease"
            class="installer-download"
            :href="androidRelease.href"
            :aria-label="androidUpdate ? '下载新版 Android APK' : '下载 Android APK'"
            download
          >
            <SvgIcon name="download" :size="17" />
            {{ androidUpdate ? '下载新版' : '下载' }}
          </a>
        </li>
        <li v-if="pwaInstall.available.value || pwaInstall.feedback.value" class="installer-row">
          <span class="platform-icon"><SvgIcon name="phone" :size="22" /></span>
          <div class="installer-info">
            <strong>网页应用（PWA）</strong>
            <small>{{ pwaInstall.feedback.value || '添加到主屏幕，以独立窗口运行' }}</small>
          </div>
          <button
            v-if="pwaInstall.available.value"
            type="button"
            class="installer-download"
            :disabled="pwaInstall.busy.value"
            @click="pwaInstall.install()"
          >
            安装应用
          </button>
        </li>
      </ul>
    </section>

    <section aria-labelledby="adapter-installer-title">
      <div class="installer-heading">
        <h2 id="adapter-installer-title">电脑适配器</h2>
        <span>支持自动更新</span>
      </div>

      <ul class="installer-list" :aria-busy="checkingInstallers" aria-live="polite">
        <li
          v-for="{ target, name, icon, format, result } in nativeRows"
          :key="target.suffix"
          class="installer-row"
        >
          <span class="platform-icon">
            <SvgIcon :name="icon" :size="22" />
          </span>
          <div class="installer-info">
            <strong>{{ name }}</strong>
            <small v-if="typeof result !== 'string'">
              v{{ result.version }} · {{ format }} · {{ sizeLabel(result.size) }}
            </small>
            <small v-else-if="result === 'loading'">正在验证安装包…</small>
            <small v-else-if="result === 'unpublished'">暂未发布</small>
            <small v-else>暂时无法验证安装包</small>
          </div>
          <a
            v-if="typeof result !== 'string'"
            class="installer-download"
            :href="result.href"
            :aria-label="'下载 ' + name"
            download
          >
            <SvgIcon name="download" :size="17" />
            下载
          </a>
          <button
            v-else-if="result === 'error'"
            type="button"
            class="installer-retry"
            :aria-label="'重新检查 ' + name"
            @click="checkInstaller(target)"
          >
            重试
          </button>
        </li>
      </ul>
      <p class="installer-note">Linux 便携包的启动方式见包内说明。DEB 安装更新时需要系统授权。</p>
    </section>

    <div class="download-details">
      <details v-if="verifiedRows.length">
        <summary>
          签名清单
          <SvgIcon name="chevron" :size="18" />
        </summary>
        <ul class="download-links">
          <li v-for="{ name, release } in verifiedRows" :key="name">
            <a :href="release.manifest" :aria-label="name + ' 签名清单'">{{ name }}</a>
            <small v-if="release.releaseKeyOnly">发布密钥验签</small>
          </li>
        </ul>
      </details>
      <a
        v-if="sourceArchive"
        class="source-download"
        :href="sourceArchive.href"
        :aria-label="'下载源码包 v' + sourceArchive.version"
      >
        <span
          >源码包 <small>v{{ sourceArchive.version }} · TAR.GZ</small></span
        >
        <SvgIcon name="download" :size="18" />
      </a>
    </div>
  </div>
</template>

<style scoped>
.adapter-downloads {
  --download-divider: color-mix(in srgb, var(--outline) 55%, transparent);
  width: min(100%, 640px);
  margin-inline: auto;
  padding: clamp(24px, 5vw, 44px) 24px 40px;
  color: var(--ink);
}

.installer-heading span,
.installer-note,
.installer-info small,
.download-links small,
.source-download small {
  color: var(--muted);
  line-height: 1.5;
}

.mobile-installer {
  margin-bottom: 30px;
}

.software-update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 26px;
  padding: 14px;
  border: 1px solid var(--outline);
  border-radius: 14px;
}

.installer-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.installer-heading h2 {
  margin: 0;
  font-size: 18px;
}

.installer-heading span,
.installer-note {
  font-size: 13px;
}

.installer-list {
  margin: 0 -6px;
  padding: 0 14px;
  list-style: none;
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 88%, var(--surface-subtle));
}

.installer-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding-block: 11px;
}

.installer-row + .installer-row {
  border-top: 1px solid var(--download-divider);
}

.platform-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 13%, var(--surface));
  color: var(--accent);
}

.installer-info {
  display: grid;
  gap: 4px;
  overflow-wrap: anywhere;
}

.installer-info strong {
  font-size: 16px;
  line-height: 1.25;
  font-weight: 650;
}

.installer-info small,
.download-links small,
.source-download small {
  font-size: 12px;
}

.installer-download,
.installer-retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 42px;
  border-radius: 10px;
  padding: 0 12px;
  font-size: 14px;
  font-weight: 650;
  white-space: nowrap;
}

.installer-download {
  background: var(--accent);
  color: var(--on-accent);
  text-decoration: none;
}

.installer-download:hover {
  background: color-mix(in srgb, var(--accent) 88%, var(--ink));
  color: var(--on-accent);
}

.installer-download:disabled {
  opacity: 0.55;
  cursor: default;
}

.installer-retry {
  border: 1px solid var(--outline);
  background: var(--surface);
  color: var(--accent);
  cursor: pointer;
}

.installer-note {
  margin: 12px 0 24px;
}

.download-details {
  border-top: 1px solid var(--download-divider);
}

.download-details details,
.source-download {
  border-bottom: 1px solid var(--download-divider);
}

.download-details summary,
.source-download {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding-block: 8px;
  font-size: 16px;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.download-details summary::-webkit-details-marker {
  display: none;
}

.download-details details[open] > summary svg {
  transform: rotate(90deg);
}

.source-download {
  text-decoration: none;
  color: var(--ink);
}

.source-download small {
  margin-inline-start: 5px;
  font-weight: 400;
}

.download-details summary:hover,
.source-download:hover {
  color: var(--accent);
}

.adapter-downloads :is(a, button, summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.download-links {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0 0 12px;
  list-style: none;
  font-size: 14px;
}

.download-links li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
}

.download-links a {
  color: var(--accent);
  padding-block: 5px;
}

@media (max-width: 420px) {
  .adapter-downloads {
    padding-inline: 20px;
  }
}

@media (max-width: 360px) {
  .installer-list {
    padding-inline: 10px;
  }

  .installer-row {
    gap: 8px;
  }

  .platform-icon {
    width: 36px;
    height: 36px;
  }

  .installer-download,
  .installer-retry {
    padding-inline: 9px;
  }
}
</style>
