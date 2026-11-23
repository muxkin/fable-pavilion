<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import SvgIcon from '../SvgIcon.vue';
import ThemeEditor from './ThemeEditor.vue';
import { appIconIds, appIconPath, appIcons, type AppIconId } from './app-icons';
import {
  exportThemes,
  importThemes,
  MAX_CUSTOM_THEMES,
  presets,
  themeTokens,
  type Appearance,
  type ColorMode,
  type Theme,
} from './palette';
import { appearanceSnapshot, subscribeAppearance, updateAppearance } from './store';
import { localeMode, resolvedLocale, setLocaleMode, t, type LocaleMode } from '../../shared/i18n';
import { useAppZoom } from '../shell/app-zoom';

const snapshot = shallowRef(appearanceSnapshot());
onScopeDispose(
  subscribeAppearance(() => {
    snapshot.value = appearanceSnapshot();
  }),
);

const settings = computed(() => snapshot.value.settings);
const resolved = computed(() => snapshot.value.resolved);
const { scale: zoomScale, change: changeZoom } = useAppZoom();
const zoomPercent = computed(() => {
  const percent = zoomScale.value * 100;
  return `${percent >= 1 ? Math.round(percent) : Number(percent.toPrecision(2))}%`;
});
const themes = computed(() => [...presets, ...settings.value.customThemes]);
const customThemeIds = computed(() => new Set(settings.value.customThemes.map((theme) => theme.id)));
const displayModes = computed(
  () =>
    [
      ['system', t('跟随系统', 'System'), 'monitor'],
      ['light', t('浅色', 'Light'), 'sun'],
      ['dark', t('深色', 'Dark'), 'moon'],
    ] as const,
);
const languageModes = computed(
  () =>
    [
      ['system', t('跟随系统', 'System'), 'globe'],
      ['zh', '简体中文', 'translate'],
      ['en', 'English', 'translate'],
    ] as const,
);
const presetName = (theme: Theme) => {
  if (resolvedLocale.value !== 'en') return theme.name;
  const map: Record<string, string> = {
    'pavilion-light': 'Moon White',
    'pavilion-dark': 'Night Pavilion',
    'jade-light': 'Jade Bamboo',
    'blue-light': 'Clear Sky',
    'jade-dark': 'Deep Jade',
    'blue-dark': 'Deep Sea',
  };
  return map[theme.id] ?? theme.name;
};
const appIconLabel = (id: AppIconId) => {
  if (resolvedLocale.value !== 'en') return appIcons[id];
  return id === 'wuyou' ? 'Wuyou' : id === 'zixu' ? 'Zixu' : 'Pavilion';
};
const themeModes = ['light', 'dark'] as const;
const editor = shallowRef<Theme>();
const deleting = ref<string>();
const notice = ref('');
const fileInput = ref<HTMLInputElement>();

function save(next: Appearance) {
  try {
    updateAppearance(next);
    notice.value = '';
    return true;
  } catch {
    notice.value = '无法保存，请检查浏览器存储空间或权限';
    return false;
  }
}
function selectMode(event: MouseEvent, mode: Appearance['mode']) {
  if (mode !== settings.value.mode && !save({ ...settings.value, mode })) event.preventDefault();
}
function selectAppIcon(event: MouseEvent, appIcon: AppIconId) {
  if (appIcon !== settings.value.appIcon && !save({ ...settings.value, appIcon })) event.preventDefault();
}
function selectLocale(mode: LocaleMode) {
  setLocaleMode(mode);
}
function selectBackdrop(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!save({ ...settings.value, backdrop: input.checked })) input.checked = settings.value.backdrop;
}
function selectLineNumbers(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!save({ ...settings.value, lineNumbers: input.checked })) input.checked = settings.value.lineNumbers;
}
function add(mode: ColorMode) {
  if (settings.value.customThemes.length >= MAX_CUSTOM_THEMES) {
    notice.value = `最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`;
    return;
  }
  editor.value = { id: `custom-${crypto.randomUUID()}`, name: '', mode, seed: '#197b66' };
}
function download(theme: Theme) {
  const url = URL.createObjectURL(new Blob([exportThemes([theme])], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${theme.name.replace(/[\\/:*?"<>|]/g, '_')}.theme.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function deleteTheme(theme: Theme) {
  const customThemes = settings.value.customThemes.filter((item) => item.id !== theme.id);
  if (save({ ...settings.value, customThemes })) deleting.value = undefined;
}
function saveTheme(theme: Theme) {
  const customThemes = settings.value.customThemes.filter((item) => item.id !== theme.id);
  updateAppearance({
    ...settings.value,
    customThemes: [...customThemes, theme],
    [theme.mode]: theme.id,
  });
  editor.value = undefined;
  notice.value = '主题已保存';
}
async function importFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    if (file.size > 32768) throw Error('主题文件过大（最多 32 KB）');
    const imported = importThemes(await file.text());
    const current = settings.value;
    if (current.customThemes.length + imported.length > MAX_CUSTOM_THEMES)
      throw Error(`最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`);
    if (
      save({
        ...current,
        customThemes: [
          ...current.customThemes,
          ...imported.map((theme) => ({ ...theme, id: `custom-${crypto.randomUUID()}` })),
        ],
      })
    ) {
      notice.value = `已导入 ${imported.length} 个主题，可在对应模式中选择`;
    }
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '主题导入失败';
  }
}
</script>

<template>
  <div class="appearance-settings">
    <section class="appearance-intro">
      <h2>{{ t('让界面合你心意', 'Make It Yours') }}</h2>
      <p>{{ t('浅色与深色，各有自己的配色。', 'Light and dark modes each keep their own color palette.') }}</p>
    </section>
    <fieldset class="theme-mode-picker">
      <legend>{{ t('显示模式', 'Display Mode') }}</legend>
      <div class="appearance-segmented">
        <label v-for="[mode, label, icon] in displayModes" :key="mode">
          <input
            type="radio"
            name="appearance-mode"
            :value="mode"
            :checked="settings.mode === mode"
            @click="selectMode($event, mode)"
          />
          <span><SvgIcon :name="icon" :size="18" />{{ label }}</span>
        </label>
      </div>
      <p class="hint">
        {{
          settings.mode === 'system'
            ? t(
                `随设备自动切换，当前为${resolved === 'light' ? '浅色' : '深色'}。`,
                `Follows device appearance (currently ${resolved === 'light' ? 'Light' : 'Dark'}).`,
              )
            : t(
                `始终使用${resolved === 'light' ? '浅色' : '深色'}模式。`,
                `Always uses ${resolved === 'light' ? 'Light' : 'Dark'} mode.`,
              )
        }}
      </p>
    </fieldset>
    <fieldset class="theme-mode-picker" style="margin-top: 22px">
      <legend>{{ t('界面语言', 'Interface Language') }}</legend>
      <div class="appearance-segmented">
        <label v-for="[mode, label, icon] in languageModes" :key="mode">
          <input
            type="radio"
            name="appearance-locale"
            :value="mode"
            :checked="localeMode === mode"
            @change="selectLocale(mode)"
          />
          <span><SvgIcon :name="icon" :size="18" />{{ label }}</span>
        </label>
      </div>
      <p class="hint">
        {{
          localeMode === 'system'
            ? t(
                `随系统语言切换，当前为${resolvedLocale === 'en' ? 'English' : '简体中文'}。`,
                `Follows browser language (currently ${resolvedLocale === 'en' ? 'English' : 'Chinese'}).`,
              )
            : t(
                `当前使用${resolvedLocale === 'en' ? 'English' : '简体中文'}界面。`,
                `Currently using ${resolvedLocale === 'en' ? 'English' : 'Chinese'} interface.`,
              )
        }}
      </p>
    </fieldset>
    <fieldset class="app-icon-picker" aria-describedby="app-icon-hint">
      <legend>{{ t('应用图标', 'App Icon') }}</legend>
      <div class="app-icon-options">
        <label v-for="id in appIconIds" :key="id">
          <input
            type="radio"
            name="app-icon"
            :value="id"
            :checked="settings.appIcon === id"
            @click="selectAppIcon($event, id)"
          />
          <span class="app-icon-option">
            <img :src="appIconPath(id)" alt="" width="52" height="52" />
            {{ appIconLabel(id) }}
            <span class="app-icon-check"><SvgIcon name="check" :size="13" /></span>
          </span>
        </label>
      </div>
      <p id="app-icon-hint" class="hint">
        {{
          t(
            '选择会保存在当前浏览器。已安装的桌面或主屏幕图标由浏览器和系统更新，有时需要重新添加。',
            'Saved in this browser. Installed desktop or home-screen icons are refreshed by the OS.',
          )
        }}
      </p>
    </fieldset>
    <fieldset class="source-display-settings">
      <legend>{{ t('界面与文本', 'Display & Text') }}</legend>
      <div class="appearance-zoom-row">
        <span id="appearance-interface-zoom">{{ t('界面缩放', 'Interface zoom') }}</span>
        <div class="appearance-zoom-controls" role="group" aria-labelledby="appearance-interface-zoom">
          <button
            type="button"
            :aria-label="t('缩小界面', 'Zoom out')"
            :title="t('缩小界面', 'Zoom out')"
            @click="changeZoom('out')"
          >
            <SvgIcon name="minus" :size="16" />
          </button>
          <button
            type="button"
            class="appearance-zoom-value"
            :aria-label="
              t(`重置界面缩放，当前 ${zoomPercent}`, `Reset interface zoom, currently ${zoomPercent}`)
            "
            :title="t('重置为 100%', 'Reset to 100%')"
            @click="changeZoom('reset')"
          >
            {{ zoomPercent }}
          </button>
          <button
            type="button"
            :aria-label="t('放大界面', 'Zoom in')"
            :title="t('放大界面', 'Zoom in')"
            @click="changeZoom('in')"
          >
            <SvgIcon name="plus" :size="16" />
          </button>
        </div>
        <span class="sr-only" role="status">{{ t(`界面缩放 ${zoomPercent}`, `Interface zoom ${zoomPercent}`) }}</span>
      </div>
      <label>
        <span>{{ t('亭台背景画', 'Pavilion backdrop artwork') }}</span>
        <input type="checkbox" role="switch" :checked="settings.backdrop" @change="selectBackdrop" />
      </label>
      <label>
        <span>{{ t('显示行号', 'Show code line numbers') }}</span>
        <input type="checkbox" role="switch" :checked="settings.lineNumbers" @change="selectLineNumbers" />
      </label>
    </fieldset>
    <section v-for="mode in themeModes" :key="mode" class="theme-section" :aria-labelledby="`${mode}-themes`">
      <header>
        <div>
          <h2 :id="`${mode}-themes`">
            {{ mode === 'light' ? t('浅色主题', 'Light Themes') : t('深色主题', 'Dark Themes') }}
          </h2>
          <p class="hint">
            {{ resolved === mode ? t('当前模式', 'Active mode') : t('切换到此模式时使用', 'Used when switching to this mode') }}
          </p>
        </div>
        <button
          class="theme-add"
          :aria-label="mode === 'light' ? t('添加浅色主题', 'Add Light Theme') : t('添加深色主题', 'Add Dark Theme')"
          @click="add(mode)"
        >
          <SvgIcon name="plus" :size="18" />{{ t('添加主题', 'Add Theme') }}
        </button>
      </header>
      <div class="theme-grid">
        <article
          v-for="theme in themes.filter((item) => item.mode === mode)"
          :key="theme.id"
          class="theme-card"
          :class="{ 'theme-card-custom': customThemeIds.has(theme.id) }"
        >
          <button
            type="button"
            class="theme-select"
            :aria-label="t(`选择${theme.name}`, `Select ${presetName(theme)}`)"
            :aria-pressed="settings[mode] === theme.id"
            @click="save({ ...settings, [mode]: theme.id })"
          >
            <div
              class="theme-preview"
              :data-preview-theme="theme.id"
              :data-preview-mode="theme.mode"
              :style="themeTokens(theme)"
              aria-hidden="true"
            >
              <div class="theme-preview-rail"><i></i><i></i><i></i></div>
              <div class="theme-preview-chat">
                <span class="theme-preview-bubble"></span>
                <span class="theme-preview-line"></span>
                <span class="theme-preview-line short"></span>
                <span class="theme-preview-input"><i></i></span>
              </div>
            </div>
            <span class="theme-card-label">
              <strong>{{ presetName(theme) }}</strong>
              <span v-if="settings[mode] === theme.id">
                <SvgIcon name="check" :size="16" />{{ t('已选择', 'Selected') }}
              </span>
              <small v-else>{{ customThemeIds.has(theme.id) ? t('自定义', 'Custom') : t('预设', 'Preset') }}</small>
            </span>
          </button>
          <div class="theme-card-tools">
            <button
              type="button"
              :title="t('导出主题', 'Export Theme')"
              :aria-label="t(`导出${theme.name}`, `Export ${presetName(theme)}`)"
              @click="download(theme)"
            >
              <SvgIcon name="download" :size="16" />
            </button>
            <template v-if="customThemeIds.has(theme.id)">
              <button
                type="button"
                :title="t('编辑主题', 'Edit Theme')"
                :aria-label="t(`编辑${theme.name}`, `Edit ${presetName(theme)}`)"
                @click="editor = theme"
              >
                <SvgIcon name="sliders" :size="16" />
              </button>
              <button
                type="button"
                :title="t('删除主题', 'Delete Theme')"
                :aria-label="t(`删除${theme.name}`, `Delete ${presetName(theme)}`)"
                @click="deleting = theme.id"
              >
                <SvgIcon name="trash" :size="16" />
              </button>
            </template>
          </div>
          <div v-if="deleting === theme.id" class="theme-delete-confirm">
            <p>{{ t(`删除“${theme.name}”？`, `Delete "${presetName(theme)}"?`) }}</p>
            <button class="secondary" @click="deleting = undefined">{{ t('取消', 'Cancel') }}</button>
            <button class="danger" @click="deleteTheme(theme)">{{ t('确认删除', 'Confirm Delete') }}</button>
          </div>
        </article>
      </div>
    </section>
    <div class="theme-import">
      <button class="secondary" @click="fileInput?.click()">
        <SvgIcon name="upload" :size="18" />{{ t('导入主题', 'Import Theme') }}
      </button>
      <p class="hint">
        {{ t('主题保存在此浏览器。导出后可在其他设备导入。', 'Themes are stored locally. Export to import on other devices.') }}
      </p>
      <input
        ref="fileInput"
        hidden
        type="file"
        accept=".json,application/json"
        :aria-label="t('导入主题文件', 'Import theme JSON file')"
        @change="importFile"
      />
    </div>
    <p v-if="notice" class="appearance-notice" role="status">{{ notice }}</p>
    <ThemeEditor v-if="editor" :theme="editor" :save="saveTheme" @close="editor = undefined" />
  </div>
</template>

<style scoped>
.source-display-settings {
  min-inline-size: 0;
}

.appearance-zoom-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
  min-block-size: 52px;
  padding-block: 4px;
  border-block-end: 1px solid var(--line);
}

.appearance-zoom-controls {
  display: grid;
  grid-template-columns: minmax(0, 44fr) minmax(0, 56fr) minmax(0, 44fr);
  inline-size: min(146px, 100%);
  min-block-size: 46px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-subtle);
}

.appearance-zoom-controls button {
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 7px;
}

.appearance-zoom-controls button:hover:not(:disabled) {
  background: var(--soft);
}

.appearance-zoom-controls button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.appearance-zoom-controls .appearance-zoom-value {
  border-inline: 1px solid var(--line);
  border-radius: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.theme-grid {
  align-items: start;
  gap: clamp(8px, 2.5vw, 16px);
}

.theme-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
}

.theme-card:has(.theme-select:hover) {
  border-color: var(--outline);
}

.theme-card:has(.theme-select[aria-pressed='true']) {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.theme-select[aria-pressed] {
  grid-area: 1 / 1;
  border: 0;
  padding: 6px;
  background: transparent;
}

.theme-card-label {
  flex-direction: column;
  align-items: start;
  justify-content: center;
  gap: 2px;
  min-height: 48px;
  padding: 5px 5px 0;
  line-height: 1.3;
}

.theme-card:not(.theme-card-custom):has(.theme-card-tools) .theme-card-label {
  padding-inline-end: 49px;
}

.theme-card-tools {
  padding: 0;
}

.theme-card-tools button {
  width: 44px;
  height: 44px;
  padding: 0;
}

.theme-card:not(.theme-card-custom) .theme-card-tools {
  grid-area: 1 / 1;
  place-self: end;
  margin: 0 6px 6px;
}

.theme-card-custom .theme-card-tools {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  justify-self: end;
  width: min(136px, calc(100% - 12px));
  margin: 0 6px 6px;
}

.theme-card-custom .theme-card-tools button {
  width: 100%;
}

.theme-delete-confirm {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 6px 6px;
  padding: 8px;
}

.theme-delete-confirm p {
  width: 100%;
  margin: 0;
}

@media (max-width: 600px) {
  .theme-section {
    margin-top: 25px;
  }

  .theme-section > header {
    margin-bottom: 10px;
  }

  .theme-preview {
    height: clamp(76px, 23vw, 100px);
  }
}

@media (max-width: 340px) {
  .appearance-settings {
    padding-inline: 14px;
  }
}
</style>
