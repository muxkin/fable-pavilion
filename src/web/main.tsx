import './theme/boot.js';
import { installBrowserCompatibility } from './browser-compat';
import { setStartupLoginMode, setStartupSession } from './startup-session';
import type { AccountClient } from '../client/account';
import type { ChatUser } from '../shared/messaging';

type Connection = { saveData?: boolean; effectiveType?: string; downlink?: number };
const connection = (navigator as Navigator & { connection?: Connection }).connection;
const fasterConnection =
  connection?.effectiveType === '4g' && !connection.saveData && (connection.downlink ?? 0) >= 0.5;

const entry = document.getElementById('app-startup');
if (entry) {
  if (
    typeof AbortController === 'function' &&
    typeof AbortSignal === 'function' &&
    globalThis.crypto?.subtle
  ) {
    installBrowserCompatibility();
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
    start(entry);
  } else {
    entry.querySelector('[data-startup-status]')!.textContent =
      '当前浏览器不支持安全登录，请更新浏览器后重试。';
  }
}

function start(entry: HTMLElement) {
  const status = entry.querySelector<HTMLElement>('[data-startup-status]')!;
  const retry = entry.querySelector<HTMLButtonElement>('[data-startup-retry]')!;
  const scan = entry.querySelector<HTMLButtonElement>('[data-lite-scan]')!;
  const album = entry.querySelector<HTMLInputElement>('[data-lite-album] input')!;
  const showCode = entry.querySelector<HTMLButtonElement>('[data-lite-app]')!;
  const recover = entry.querySelector<HTMLButtonElement>('[data-lite-recovery]')!;
  const full = entry.querySelector<HTMLButtonElement>('[data-lite-full]')!;
  let lite: ReturnType<typeof import('./lite-login').installLiteQr> | undefined;
  let opening = false;
  let slowTimer: ReturnType<typeof setTimeout>;

  function working(message: string) {
    clearTimeout(slowTimer);
    status.textContent = message;
    retry.hidden = true;
    slowTimer = setTimeout(() => {
      status.textContent = message.startsWith('已登录')
        ? '已登录，网络较慢，仍在打开完整页面…'
        : '网络较慢，仍在加载…';
    }, 10000);
  }

  function failed() {
    clearTimeout(slowTimer);
    status.textContent = navigator.onLine ? '连接失败，请重试。' : '当前离线，请在联网后重试。';
    retry.hidden = false;
  }

  retry.addEventListener('click', () => location.reload());
  window.addEventListener('pocket:app-ready', () => clearTimeout(slowTimer), { once: true });

  function setControls(enabled: boolean) {
    for (const control of [scan, album, showCode, recover, full]) control.disabled = !enabled;
  }

  async function session(): Promise<ChatUser | null> {
    const response = await fetch('/api/im/me', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('Unable to check the session');
    return (await response.json()).user ?? null;
  }

  const initialSession = session();
  // A failed early probe can be retried by the full app on a fast connection.
  void initialSession.catch(() => {});

  function openApp(account?: AccountClient, mode?: 'recovery' | 'qr') {
    if (opening) return;
    opening = true;
    lite?.dispose();
    setControls(false);
    working(account?.user ? '已登录，正在打开完整页面…' : '正在打开完整页面…');
    setStartupSession(account?.user ? Promise.resolve(account.user) : initialSession);
    if (mode) setStartupLoginMode(mode);
    void import('./mount-app').catch(failed);
  }

  if (!__POCKET_DEVICE_LOGIN_ONLY__ || fasterConnection) {
    openApp();
    return;
  }

  working('正在连接…');
  const lightweight = import('./lite-login');
  void lightweight.catch(() => {});
  void initialSession
    .then(async (user) => {
      if (user) {
        openApp();
        return;
      }
      const { installLiteQr } = await lightweight;
      lite = installLiteQr(entry, openApp);
      clearTimeout(slowTimer);
      status.textContent = '';
      entry.dataset.startupReady = 'true';
      setControls(true);
      full.hidden = false;
      full.addEventListener('click', () => openApp());
      scan.addEventListener('click', () => void lite?.camera());
      album.addEventListener('change', () => {
        const file = album.files?.[0];
        album.value = '';
        if (file) void lite?.image(file);
      });
      showCode.addEventListener('click', () => void lite?.localCode());
      recover.addEventListener('click', () => openApp(undefined, 'recovery'));
      void fetch('/api/im/status', { cache: 'no-store', signal: AbortSignal.timeout(12000) })
        .then(async (response) => {
          if (!response.ok) return;
          const { registrationEnabled } = await response.json();
          entry.querySelector<HTMLElement>('[data-lite-closed]')!.hidden = registrationEnabled !== false;
        })
        .catch(() => {});
    })
    .catch(failed);
}
