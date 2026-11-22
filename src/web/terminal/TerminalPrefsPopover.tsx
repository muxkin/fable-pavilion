import { tsxComponent } from '../tsx-component';
import { Icon } from '../Icon';
import {
  TERMINAL_FONT_PRESETS,
  TERMINAL_THEMES,
  type TerminalCursorStyle,
  type TerminalPreferences,
  type TerminalThemeId,
} from './terminal-prefs';

export const TerminalPrefsPopover = tsxComponent(function TerminalPrefsPopover(_props: {
  prefs: TerminalPreferences;
  keybarOpen: boolean;
  onUpdate: (next: TerminalPreferences) => void;
  onToggleKeybar: () => void;
  onExportTranscript: () => void;
  onClose: () => void;
}) {
  return ({ prefs, keybarOpen, onUpdate, onToggleKeybar, onExportTranscript, onClose }) => {
    const matchingPreset = TERMINAL_FONT_PRESETS.find((p) => p.value === prefs.fontFamily)?.id ?? 'custom';

    return (
      <div class="term-popover term-prefs-popover" role="dialog" aria-label="终端偏好设置" onClick={(e) => e.stopPropagation()}>
        <header class="term-popover-head">
          <strong>终端外观与偏好</strong>
          <button type="button" class="term-icon-btn sm" aria-label="关闭偏好设置" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div class="term-prefs-group">
          <span>配色主题</span>
          <div class="term-theme-grid">
            {(Object.keys(TERMINAL_THEMES) as TerminalThemeId[]).map((id) => {
              const preset = TERMINAL_THEMES[id];
              return (
                <button
                  key={id}
                  type="button"
                  class={`term-theme-chip${prefs.theme === id ? ' active' : ''}`}
                  onClick={() => onUpdate({ ...prefs, theme: id })}
                >
                  <i style={`background:${preset.canvasBg};border-color:${preset.accent}`} />
                  <span>{preset.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div class="term-prefs-group">
          <span>字体（Nerd Font / Powerline）</span>
          <select
            aria-label="终端字体预设"
            value={matchingPreset}
            onChange={(e) => {
              const id = (e.currentTarget as HTMLSelectElement).value;
              const found = TERMINAL_FONT_PRESETS.find((p) => p.id === id);
              if (found) onUpdate({ ...prefs, fontFamily: found.value });
            }}
          >
            {TERMINAL_FONT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            {matchingPreset === 'custom' && <option value="custom">自定义字体</option>}
          </select>
          <input
            type="text"
            aria-label="自定义字体族"
            value={prefs.fontFamily}
            placeholder="例如: 'MesloLGS NF', monospace"
            onInput={(e) => onUpdate({ ...prefs, fontFamily: (e.currentTarget as HTMLInputElement).value })}
          />
        </div>

        <div class="term-prefs-row">
          <div class="term-prefs-group" style="flex:1">
            <span>字号 ({prefs.fontSize}px)</span>
            <input
              type="range"
              min={10}
              max={24}
              step={1}
              value={prefs.fontSize}
              onInput={(e) => onUpdate({ ...prefs, fontSize: Number((e.currentTarget as HTMLInputElement).value) })}
            />
          </div>
          <div class="term-prefs-group" style="flex:1">
            <span>行高 ({prefs.lineHeight})</span>
            <input
              type="range"
              min={1}
              max={1.6}
              step={0.05}
              value={prefs.lineHeight}
              onInput={(e) => onUpdate({ ...prefs, lineHeight: Number((e.currentTarget as HTMLInputElement).value) })}
            />
          </div>
        </div>

        <div class="term-prefs-group">
          <span>光标样式</span>
          <div class="term-seg-row">
            {([
              ['block', '块状'],
              ['bar', '竖线'],
              ['underline', '下划线'],
            ] as [TerminalCursorStyle, string][]).map(([style, label]) => (
              <button
                key={style}
                type="button"
                class={prefs.cursorStyle === style ? 'active' : undefined}
                onClick={() => onUpdate({ ...prefs, cursorStyle: style })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div class="term-prefs-toggles">
          <label class="term-toggle-line">
            <span>光标闪烁</span>
            <input
              type="checkbox"
              checked={prefs.cursorBlink}
              onChange={(e) => onUpdate({ ...prefs, cursorBlink: (e.currentTarget as HTMLInputElement).checked })}
            />
          </label>
          <label class="term-toggle-line">
            <span>选中文本自动复制</span>
            <input
              type="checkbox"
              checked={prefs.copyOnSelect}
              onChange={(e) => onUpdate({ ...prefs, copyOnSelect: (e.currentTarget as HTMLInputElement).checked })}
            />
          </label>
          <label class="term-toggle-line">
            <span>显示底部快捷按键栏</span>
            <input type="checkbox" checked={keybarOpen} onChange={onToggleKeybar} />
          </label>
        </div>

        <div class="term-prefs-footer">
          <button
            type="button"
            class="term-action-btn"
            onClick={() => {
              onExportTranscript();
              onClose();
            }}
          >
            <Icon name="download" size={14} /> 导出当前终端记录
          </button>
        </div>
      </div>
    );
  };
});
