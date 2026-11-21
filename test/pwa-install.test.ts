import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPwaInstallForTest,
  canInstallPwa,
  installPwaPromptCapture,
  promptPwaInstall,
  pwaInstallFeedback,
} from '../src/web/pwa-install';

let fakeWindow: EventTarget & {
  matchMedia: (q: string) => { matches: boolean };
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

function dispatchInstallPrompt(options: {
  prompt?: () => Promise<void>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}) {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = options.prompt ?? (() => Promise.resolve());
  event.userChoice = options.userChoice ?? Promise.resolve({ outcome: 'accepted' });
  fakeWindow.dispatchEvent(event);
  return event;
}

describe('pwa-install', () => {
  beforeEach(() => {
    const target = new EventTarget();
    fakeWindow = Object.assign(target, {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 HuaweiBrowser/15.0' });
    installPwaPromptCapture();
  });

  afterEach(() => {
    _resetPwaInstallForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('invokes event.prompt() synchronously before clearing availability', async () => {
    let availableDuringPrompt = false;
    dispatchInstallPrompt({
      prompt: () => {
        availableDuringPrompt = canInstallPwa();
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    expect(canInstallPwa()).toBe(true);
    const outcome = await promptPwaInstall();
    expect(availableDuringPrompt).toBe(true);
    expect(outcome).toBe('accepted');
    expect(canInstallPwa()).toBe(false);
    expect(pwaInstallFeedback()).toContain('已提交安装请求');
  });

  it('surfaces actionable feedback when the browser immediately dismisses or rejects prompt()', async () => {
    dispatchInstallPrompt({
      prompt: () => Promise.reject(new DOMException('Not supported', 'NotAllowedError')),
    });
    const rejected = await promptPwaInstall();
    expect(rejected).toBe('unsupported');
    expect(pwaInstallFeedback()).toContain('创建桌面快捷方式');

    _resetPwaInstallForTest();
    dispatchInstallPrompt({
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    const instantDismiss = await promptPwaInstall();
    expect(instantDismiss).toBe('unsupported');
    expect(pwaInstallFeedback()).toContain('浏览器直接驳回了安装弹窗');
  });
});
