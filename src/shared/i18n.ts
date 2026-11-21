import { computed, shallowRef } from 'vue';

export type LocaleMode = 'system' | 'zh' | 'en';
export type ResolvedLocale = 'zh' | 'en';

export const LOCALE_STORAGE_KEY = 'pocket-locale-v1';

function readUrlLocale(): LocaleMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const param = new URLSearchParams(window.location.search).get('lang')?.trim().toLowerCase();
    if (param === 'en' || param === 'en-us' || param === 'en-gb') return 'en';
    if (param === 'zh' || param === 'zh-cn' || param === 'zh-hans') return 'zh';
    if (param === 'system') return 'system';
  } catch {}
  return null;
}

function readStoredLocale(): LocaleMode {
  const fromUrl = readUrlLocale();
  if (fromUrl) {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, fromUrl);
    } catch {}
    return fromUrl;
  }
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === 'zh' || raw === 'en' || raw === 'system') return raw;
  } catch {}
  return 'system';
}

export function resolveSystemLocale(): ResolvedLocale {
  if (typeof navigator === 'undefined') return 'zh';
  // Keep headless automated test runners deterministic unless an explicit preference was saved.
  if (navigator.webdriver) return 'zh';
  const lang = (navigator.languages?.[0] || navigator.language || '').toLowerCase();
  if (!lang || lang.startsWith('zh')) return 'zh';
  return 'en';
}

const modeRef = shallowRef<LocaleMode>(readStoredLocale());
const systemRef = shallowRef<ResolvedLocale>(resolveSystemLocale());

export const localeMode = computed(() => modeRef.value);
export const resolvedLocale = computed<ResolvedLocale>(() =>
  modeRef.value === 'system' ? systemRef.value : modeRef.value,
);

let titleProvider: ((locale: ResolvedLocale) => string) | undefined;
const subscribers = new Set<(locale: ResolvedLocale) => void>();

function applyLocale() {
  const locale = resolvedLocale.value;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dataset.lang = locale;
    if (titleProvider) document.title = titleProvider(locale);
  }
  subscribers.forEach((fn) => fn(locale));
}

export function setLocaleMode(next: LocaleMode) {
  modeRef.value = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {}
  applyLocale();
}

export function toggleLocale() {
  setLocaleMode(resolvedLocale.value === 'en' ? 'zh' : 'en');
}

export function subscribeLocale(listener: (locale: ResolvedLocale) => void) {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

let initialized = false;
export function initializeLocale(getTitle?: (locale: ResolvedLocale) => string) {
  if (getTitle) titleProvider = getTitle;
  systemRef.value = resolveSystemLocale();
  applyLocale();
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('languagechange', () => {
    systemRef.value = resolveSystemLocale();
    if (modeRef.value === 'system') applyLocale();
  });
  window.addEventListener('storage', (event) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) {
      const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
      modeRef.value = raw === 'zh' || raw === 'en' || raw === 'system' ? raw : 'system';
      applyLocale();
    }
  });
}

export function t(zh: string, en: string): string {
  return resolvedLocale.value === 'en' ? en : zh;
}

export function bcp47Locale(): string {
  return resolvedLocale.value === 'en' ? 'en-US' : 'zh-CN';
}
