import {
  defaults,
  parseAppearance,
  selectedTheme,
  STORAGE_KEY,
  themeTokens,
  type Appearance,
  type ColorMode,
} from './palette';
import { applyAppIcon } from './app-icons';

function read(): Appearance {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return { ...defaults, customThemes: [] };
  }
}
const system = window.matchMedia('(prefers-color-scheme: dark)');
function systemColorMode(): ColorMode {
  const androidMode = (window as Window & { fableAndroidSystemTheme?: string }).fableAndroidSystemTheme;
  if (androidMode === 'dark' || androidMode === 'light') return androidMode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
let settings = read();
let snapshot = { settings, resolved: resolveMode(settings) };
const listeners = new Set<() => void>();
function resolveMode(value: Appearance): ColorMode {
  return value.mode === 'system' ? systemColorMode() : value.mode;
}
function apply() {
  const mode = resolveMode(settings);
  const theme = selectedTheme(settings, mode);
  for (const [key, value] of Object.entries(themeTokens(theme)))
    document.documentElement.style.setProperty(key, value);
  document.documentElement.dataset.colorMode = mode;
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.backdrop = settings.backdrop ? 'pavilion' : 'plain';
  document.documentElement.style.colorScheme = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeTokens(theme)['--surface']);
  applyAppIcon(settings.appIcon);
  snapshot = { settings, resolved: mode };
  listeners.forEach((listener) => listener());
}
function syncSystemMode() {
  if (settings.mode === 'system' && resolveMode(settings) !== snapshot.resolved) apply();
}
export function updateAppearance(next: Appearance) {
  const clean = parseAppearance(next);
  // Save first: a storage failure leaves the selected theme unchanged and can be reported by the UI.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...clean,
      paint: {
        light: themeTokens(selectedTheme(clean, 'light')),
        dark: themeTokens(selectedTheme(clean, 'dark')),
      },
    }),
  );
  settings = clean;
  apply();
}
let initialized = false;
export function initializeAppearance() {
  apply();
  if (initialized) return;
  initialized = true;
  if (typeof system.addEventListener === 'function') system.addEventListener('change', syncSystemMode);
  else if (typeof system.addListener === 'function') system.addListener(syncSystemMode);
  window.addEventListener('fable-android-system-theme', syncSystemMode);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncSystemMode();
  });
  window.addEventListener('focus', syncSystemMode);
  window.addEventListener('pageshow', syncSystemMode);
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      settings = read();
      apply();
    }
  });
}
export const subscribeAppearance = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const appearanceSnapshot = () => snapshot;
