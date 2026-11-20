export const appIcons = {
  pavilion: '子虚亭',
  zixu: '子虚',
  wuyou: '乌有',
} as const;

export type AppIconId = keyof typeof appIcons;
export const appIconIds = Object.keys(appIcons) as AppIconId[];
export const defaultAppIcon: AppIconId = 'wuyou';

export function parseAppIcon(value: unknown): AppIconId {
  return appIconIds.find((id) => id === value) ?? defaultAppIcon;
}

export function appIconPath(id: AppIconId, size: 32 | 192 | 512 = 192) {
  return `/app-icons/${id}-${size}.png`;
}

export function appManifestPath(id: AppIconId) {
  return id === defaultAppIcon ? '/manifest.webmanifest' : `/app-icons/${id}.webmanifest`;
}

export function applyAppIcon(id: AppIconId) {
  const icon = appIconPath(id);
  for (const [selector, attribute, value] of [
    ['link[rel="icon"]', 'href', appIconPath(id, 32)],
    ['link[rel="apple-touch-icon"]', 'href', icon],
    ['link[rel="manifest"]', 'href', appManifestPath(id)],
  ]) {
    const element = document.querySelector(selector);
    if (element && element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
  }
}
