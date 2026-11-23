import { shallowRef, watch } from 'vue';

type ZoomAction = 'in' | 'out' | 'reset';

const preference = 'pocket-app-zoom-level';
const level = shallowRef(0);
const scale = shallowRef(1);

function zoomFactor(value: number) {
  if (!Number.isSafeInteger(value)) return;
  const factor = 1.2 ** value;
  if (factor > 0 && Number.isFinite(factor) && Number.isFinite(1 / factor)) return factor;
}

function change(action: ZoomAction) {
  const next = action === 'reset' ? 0 : level.value + (action === 'in' ? 1 : -1);
  if (zoomFactor(next) === undefined) return;
  level.value = next;
  try {
    localStorage.setItem(preference, String(level.value));
  } catch {
    // The current page still uses the selected zoom level.
  }
}

export function useAppZoom() {
  return { scale, change };
}

export function installAppZoom() {
  const root = document.documentElement;
  let saved = 0;
  try {
    saved = Number(localStorage.getItem(preference));
  } catch {
    // Storage can be unavailable in restricted browser sessions.
  }
  level.value = zoomFactor(saved) === undefined ? 0 : saved;
  const stop = watch(
    level,
    (next) => {
      const requested = zoomFactor(next) ?? 1;
      root.style.setProperty('--app-zoom', String(requested));
      const effective = root.currentCSSZoom ?? Number(getComputedStyle(root).zoom);
      // Geometry and the reset control must use the scale the browser can actually render.
      scale.value = Number.isFinite(effective) && effective > 0 ? effective : requested;
      if (scale.value !== requested) root.style.setProperty('--app-zoom', String(scale.value));
      window.dispatchEvent(new Event('resize'));
    },
    { immediate: true, flush: 'sync' },
  );
  const onKey = (event: KeyboardEvent) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.isComposing ||
      event.getModifierState('AltGraph')
    )
      return;
    let action: ZoomAction;
    if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') action = 'in';
    else if (event.key === '-' || event.code === 'NumpadSubtract') action = 'out';
    else if (event.key === '0' || event.code === 'Numpad0') action = 'reset';
    else return;
    event.preventDefault();
    event.stopPropagation();
    change(action);
  };
  window.addEventListener('keydown', onKey, true);
  return () => {
    stop();
    window.removeEventListener('keydown', onKey, true);
    root.style.removeProperty('--app-zoom');
  };
}

// Browser viewport and DOMRect APIs report painted pixels. CSS positions and scroll offsets use layout pixels.
export function appPixels(screenPixels: number) {
  return screenPixels / scale.value;
}

export function appRect(rect: DOMRect) {
  return new DOMRect(appPixels(rect.x), appPixels(rect.y), appPixels(rect.width), appPixels(rect.height));
}

export function appViewport() {
  const viewport = window.visualViewport;
  const windowWidth = appPixels(window.innerWidth);
  const windowHeight = appPixels(window.innerHeight);
  const left = appPixels(viewport?.offsetLeft ?? 0);
  const top = appPixels(viewport?.offsetTop ?? 0);
  const width = viewport?.width === undefined ? windowWidth : appPixels(viewport.width);
  const height = viewport?.height === undefined ? windowHeight : appPixels(viewport.height);
  return { left, top, width, height, right: left + width, bottom: top + height, windowWidth, windowHeight };
}
