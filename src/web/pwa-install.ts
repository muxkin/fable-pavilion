import { onScopeDispose, shallowRef } from 'vue';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

export type PwaInstallOutcome = 'accepted' | 'dismissed' | 'unsupported' | 'unavailable';

const isAndroidWrapper = () => /\bFablePavilionAndroid\/\d+\b/.test(navigator.userAgent);
const isStandaloneDisplay = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let lastFeedback = '';
let prompting = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function canInstallPwa() {
  return deferredPrompt !== null && !isAndroidWrapper() && !isStandaloneDisplay();
}

export function pwaInstallFeedback() {
  return lastFeedback;
}

export function pwaInstallBusy() {
  return prompting;
}

export async function promptPwaInstall(): Promise<PwaInstallOutcome> {
  const event = deferredPrompt;
  if (!event || prompting || isAndroidWrapper() || isStandaloneDisplay()) return 'unavailable';
  prompting = true;
  lastFeedback = '';
  const startedAt = Date.now();
  let promptCall: Promise<void>;
  try {
    // Invoke prompt() synchronously inside the user gesture before mutating reactive state or DOM.
    promptCall = Promise.resolve(event.prompt());
  } catch {
    deferredPrompt = null;
    prompting = false;
    lastFeedback =
      '当前浏览器不支持网页内直接拉起 PWA 安装弹窗；请检查浏览器菜单「添加到桌面」及系统快捷方式权限，或使用 Chrome / Edge / Android 客户端。';
    notify();
    return 'unsupported';
  }
  deferredPrompt = null;
  notify();

  let settled = false;
  const stallTimer = window.setTimeout(() => {
    if (settled) return;
    lastFeedback =
      '当前浏览器未弹出原生安装窗口（部分定制浏览器内核虽会触发事件但未实现安装弹窗）；可检查系统「创建桌面快捷方式」权限，或改用 Chrome / Edge / Android 客户端。';
    notify();
  }, 2000);

  try {
    await promptCall;
    const choice = await event.userChoice;
    settled = true;
    window.clearTimeout(stallTimer);
    prompting = false;
    const elapsed = Date.now() - startedAt;
    if (choice?.outcome === 'accepted') {
      lastFeedback = '已提交安装请求，请稍候查看桌面图标。';
      notify();
      return 'accepted';
    }
    if (elapsed < 250) {
      lastFeedback =
        '浏览器直接驳回了安装弹窗，未显示系统确认框；请检查系统「创建桌面快捷方式」权限，或改用 Chrome / Edge / Android 客户端。';
      notify();
      return 'unsupported';
    }
    notify();
    return 'dismissed';
  } catch {
    settled = true;
    window.clearTimeout(stallTimer);
    prompting = false;
    lastFeedback =
      '当前浏览器未能弹出 PWA 安装窗口；请检查系统「创建桌面快捷方式」权限，或改用 Chrome / Edge / Android 客户端。';
    notify();
    return 'unsupported';
  }
}

export function usePwaInstall() {
  const available = shallowRef(canInstallPwa());
  const feedback = shallowRef(lastFeedback);
  const busy = shallowRef(prompting);
  const listener = () => {
    available.value = canInstallPwa();
    feedback.value = lastFeedback;
    busy.value = prompting;
  };
  listeners.add(listener);
  onScopeDispose(() => {
    listeners.delete(listener);
  });
  return {
    available,
    feedback,
    busy,
    install: promptPwaInstall,
  };
}

let installedListeners = false;
export function installPwaPromptCapture() {
  if (installedListeners || typeof window === 'undefined' || isAndroidWrapper()) return;
  installedListeners = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    if (isStandaloneDisplay()) return;
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    prompting = false;
    lastFeedback = '';
    notify();
  });
}

/** Test-only helper to reset singleton state between unit tests. */
export function _resetPwaInstallForTest() {
  deferredPrompt = null;
  lastFeedback = '';
  prompting = false;
  installedListeners = false;
  notify();
}

installPwaPromptCapture();
