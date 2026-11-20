import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { appIconIds, appIconPath, appManifestPath, defaultAppIcon } from '../src/web/theme/app-icons';
import {
  defaults,
  exportThemes,
  importThemes,
  parseAppearance,
  presets,
  selectedTheme,
  themeTokens,
} from '../src/web/theme/palette';

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('shared appearance system', () => {
  it('keeps light and dark selections independent and repairs a removed selection', () => {
    const custom = { id: 'custom-violet', name: '紫色', mode: 'dark' as const, seed: '#7453ac' };
    const state = parseAppearance({
      ...defaults,
      light: 'blue-light',
      dark: custom.id,
      customThemes: [custom],
    });
    expect(selectedTheme(state, 'light').id).toBe('blue-light');
    expect(selectedTheme(state, 'dark').id).toBe(custom.id);
    expect(parseAppearance({ ...state, customThemes: [] })).toMatchObject({
      light: 'blue-light',
      dark: defaults.dark,
    });
    expect(parseAppearance({ ...state, light: custom.id }).light).toBe(defaults.light);
  });
  it('rejects corrupted storage, duplicate IDs, preset replacement and invalid color payloads', () => {
    for (const data of [null, 'broken', [], { version: 99 }]) expect(parseAppearance(data)).toEqual(defaults);
    const custom = { id: 'custom-a', name: 'A', mode: 'light', seed: '#123456' };
    const data = parseAppearance({
      ...defaults,
      mode: 'invalid',
      customThemes: [
        custom,
        custom,
        presets[0],
        { ...custom, id: 'custom-b', seed: 'url(https://invalid)' },
        null,
      ],
    });
    expect(data.customThemes).toEqual([custom]);
    expect(data.mode).toBe('system');
  });
  it('defaults to source line numbers and preserves an explicit opt-out across theme changes', () => {
    const legacy = { version: 1, mode: 'dark', light: 'blue-light', dark: 'blue-dark', customThemes: [] };
    expect(parseAppearance(null).lineNumbers).toBe(true);
    expect(parseAppearance(legacy)).toMatchObject({ dark: 'blue-dark', lineNumbers: true });
    expect(parseAppearance({ ...legacy, lineNumbers: 'false' }).lineNumbers).toBe(true);
    const saved = parseAppearance({ ...legacy, lineNumbers: false });
    expect(parseAppearance({ ...saved, mode: 'light' })).toMatchObject({ mode: 'light', lineNumbers: false });
  });
  it('defaults to the paired pavilion themes and keeps saved selections and the application icon', () => {
    expect(parseAppearance(null)).toMatchObject({
      light: 'pavilion-light',
      dark: 'pavilion-dark',
      appIcon: 'wuyou',
    });
    const legacy = { version: 1, mode: 'system', light: 'jade-light', dark: 'blue-dark' };
    expect(parseAppearance({ ...legacy, appIcon: 'zixu' })).toMatchObject({
      ...legacy,
      appIcon: 'zixu',
    });
    expect(parseAppearance({ ...legacy, appIcon: 'foreign/icon' }).appIcon).toBe('wuyou');
  });
  it('exports and imports only portable theme data', () => {
    expect(importThemes(exportThemes(presets))).toEqual(
      presets.map(({ name, mode, seed }) => ({ name, mode, seed })),
    );
    const file = JSON.parse(exportThemes(presets));
    file.themes[0].css = 'body { display: none }';
    file.themes[0].id = 'jade-light';
    expect(importThemes(JSON.stringify(file))[0]).not.toHaveProperty('css');
    expect(importThemes(JSON.stringify(file))[0]).not.toHaveProperty('id');
    for (const bad of ['null', '{}', 'not json', JSON.stringify({ ...file, version: 2 }), 'x'.repeat(32769)])
      expect(() => importThemes(bad)).toThrow();
  });
  it('provides readable foreground/background pairs for presets and extreme custom seeds', () => {
    for (const theme of presets) {
      const tokens = themeTokens(theme);
      for (const foreground of ['--ink', '--muted', '--accent']) {
        expect(
          contrast(tokens[foreground], tokens['--surface']),
          `${theme.id} ${foreground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const mode of ['light', 'dark'] as const) {
      for (const seed of [
        '#197b66',
        '#4263a8',
        '#ffffff',
        '#000000',
        '#ffff00',
        '#ff00ff',
        '#ff0000',
        '#00ffff',
      ]) {
        const t = themeTokens({ mode, seed });
        for (const [foreground, background] of [
          ['--ink', '--surface'],
          ['--muted', '--surface'],
          ['--muted', '--surface-subtle'],
          ['--on-accent', '--accent'],
          ['--on-soft', '--soft'],
          ['--on-danger-soft', '--danger-soft'],
        ])
          expect(
            contrast(t[foreground], t[background]),
            `${mode} ${seed} ${foreground}`,
          ).toBeGreaterThanOrEqual(4.5);
        if (mode === 'light') expect(luminance(t['--surface'])).toBeGreaterThan(0.9);
        if (mode === 'dark') expect(luminance(t['--surface'])).toBeLessThan(0.03);
      }
    }
  });
});

describe('appearance before the app bundle loads', () => {
  const boot = readFileSync(new URL('../src/web/theme/boot.js', import.meta.url), 'utf8');

  function prepaint(stored: string | (() => never), prefersDark = false) {
    const theme = {
      dataset: {},
      palette: new Map<string, string>(),
      metadata: new Map(
        ['icon', 'apple-touch-icon', 'manifest'].map((rel) => [
          `link[rel="${rel}"]`,
          rel === 'manifest'
            ? appManifestPath(defaultAppIcon)
            : appIconPath(defaultAppIcon, rel === 'icon' ? 32 : 192),
        ]),
      ),
    };
    runInNewContext(boot, {
      localStorage: { getItem: typeof stored === 'string' ? () => stored : stored },
      matchMedia: () => ({ matches: prefersDark }),
      document: {
        documentElement: {
          dataset: theme.dataset,
          style: { setProperty: (name: string, value: string) => theme.palette.set(name, value) },
        },
        querySelector: (selector: string) => ({
          setAttribute: (_: string, value: string) => theme.metadata.set(selector, value),
        }),
      },
    });
    return theme;
  }

  it.each(appIconIds)('uses the persisted %s icon and its manifest on the startup screen', (appIcon) => {
    const result = prepaint(JSON.stringify({ version: 1, mode: 'dark', appIcon }));
    expect(result.dataset).toMatchObject({ colorMode: 'dark', theme: 'pavilion-dark' });
    expect(result.metadata.get('link[rel="icon"]')).toBe(appIconPath(appIcon, 32));
    expect(result.metadata.get('link[rel="apple-touch-icon"]')).toBe(appIconPath(appIcon));
    expect(result.metadata.get('link[rel="manifest"]')).toBe(appManifestPath(appIcon));
  });

  it('keeps the default icon and follows the system palette when startup data cannot be read', () => {
    for (const stored of [
      'invalid JSON',
      JSON.stringify({ version: 1, appIcon: 'foreign/icon' }),
      () => {
        throw new Error('localStorage disabled');
      },
    ]) {
      const result = prepaint(stored, true);
      expect(result.dataset).toMatchObject({ colorMode: 'dark', theme: 'pavilion-dark' });
      expect(result.palette.get('--surface')).toBe('#1a2a2f');
      expect(result.metadata.get('link[rel="icon"]')).toBe(appIconPath(defaultAppIcon, 32));
      expect(result.metadata.get('link[rel="manifest"]')).toBe(appManifestPath(defaultAppIcon));
    }
  });
});

it.each(appIconIds)('ships the correct PWA art for %s without changing the install identity', (icon) => {
  const manifest = JSON.parse(
    readFileSync(new URL(`../src/web/public${appManifestPath(icon)}`, import.meta.url), 'utf8'),
  );
  expect(manifest).toMatchObject({ id: '/', scope: '/', start_url: '/' });
  expect(manifest.icons).toMatchObject([
    { src: appIconPath(icon), sizes: '192x192' },
    { src: appIconPath(icon, 512), sizes: '512x512' },
  ]);
});
