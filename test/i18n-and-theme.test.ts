import { describe, expect, it } from 'vitest';
import { defaults, parseAppearance, presets, themeTokens } from '../src/web/theme/palette';
import { bcp47Locale, setLocaleMode, t } from '../src/shared/i18n';
import { translateZhToEn } from '../src/web/i18n/en-dict';

describe('unified preset themes and zh/en i18n', () => {
  it('defaults backdrop to true and preserves backdrop consistently across all 3 preset theme pairs', () => {
    expect(defaults.backdrop).toBe(true);
    expect(presets.filter((p) => p.mode === 'light')).toHaveLength(3);
    expect(presets.filter((p) => p.mode === 'dark')).toHaveLength(3);

    for (const preset of presets) {
      const tokens = themeTokens(preset);
      expect(tokens['--surface']).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokens['--accent']).toMatch(/^#[0-9a-f]{6}$/i);
      const parsed = parseAppearance({ ...defaults, [preset.mode]: preset.id, backdrop: false });
      expect(parsed.backdrop).toBe(false);
      expect(parsed[preset.mode]).toBe(preset.id);
    }
  });

  it('switches locale reactively and translates exact and parameterized UI chrome strings', () => {
    setLocaleMode('zh');
    expect(t('工作台', 'Workbench')).toBe('工作台');
    expect(bcp47Locale()).toBe('zh-CN');

    setLocaleMode('en');
    expect(t('工作台', 'Workbench')).toBe('Workbench');
    expect(bcp47Locale()).toBe('en-US');

    expect(translateZhToEn('消息')).toBe('Messages');
    expect(translateZhToEn('剩余 45 秒')).toBe('45s left');
    expect(translateZhToEn('UID 10000000 · 管理员')).toBe('UID 10000000 · Admin');
    expect(translateZhToEn('删除“青竹”？')).toBe('Delete "青竹"?');

    setLocaleMode('system');
  });
});
