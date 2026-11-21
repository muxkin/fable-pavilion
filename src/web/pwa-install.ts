import { onScopeDispose, shallowRef } from 'vue';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isAndroidWrapper = () => /\bFablePavilionAndroid\/\d+\b/.test(navigator.userAgent);
const isStandaloneDisplay = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function canInstallPwa() {
  return deferredPrompt !== null && !isAndroidWrapper() && !isStandaloneDisplay();
}

export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event || isAndroidWrapper() || isStandaloneDisplay()) return 'unavailable';
  deferredPrompt = null;
  notify();
  await event.prompt();
  try {
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return 'dismissed';
  }
}

export function usePwaInstall() {
  const available = shallowRef(canInstallPwa());
  const listener = () => {
    available.value = canInstallPwa();
  };
  listeners.add(listener);
  onScopeDispose(() => {
    listeners.delete(listener);
  });
  return {
    available,
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
    notify();
  });
}

installPwaPromptCapture();
