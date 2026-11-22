import type { ITheme } from '@xterm/xterm';

export type TerminalThemeId = 'pavilion-night' | 'pavilion-day' | 'tokyo-night' | 'dracula' | 'nord' | 'one-dark';
export type TerminalCursorStyle = 'block' | 'bar' | 'underline';

export interface TerminalThemePreset {
  id: TerminalThemeId;
  name: string;
  light?: boolean;
  chromeBg: string;
  panelBg: string;
  canvasBg: string;
  border: string;
  ink: string;
  muted: string;
  accent: string;
  xterm: ITheme;
}

export const DEFAULT_NERD_FONT_STACK =
  "'MesloLGS NF', 'MesloLGS Nerd Font Mono', 'MesloLGS Nerd Font', 'MesloLGL Nerd Font Mono', 'MesloLGM Nerd Font Mono', 'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'CaskaydiaCove Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono', 'FantasqueSansM Nerd Font Mono', 'Symbols Nerd Font Mono', 'Cascadia Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const TERMINAL_FONT_PRESETS: { id: string; label: string; value: string }[] = [
  { id: 'auto-nerd', label: 'Nerd Font 自动优先（推荐）', value: DEFAULT_NERD_FONT_STACK },
  {
    id: 'meslo',
    label: 'MesloLGS Nerd Font',
    value: "'MesloLGS NF', 'MesloLGS Nerd Font Mono', 'MesloLGL Nerd Font Mono', monospace",
  },
  {
    id: 'jetbrains',
    label: 'JetBrainsMono Nerd Font',
    value: "'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
  },
  {
    id: 'cascadia',
    label: 'CaskaydiaCove / Cascadia',
    value: "'CaskaydiaCove Nerd Font Mono', 'Cascadia Code', Consolas, monospace",
  },
  {
    id: 'fira',
    label: 'FiraCode Nerd Font',
    value: "'FiraCode Nerd Font Mono', 'Fira Code', monospace",
  },
];

export const TERMINAL_THEMES: Record<TerminalThemeId, TerminalThemePreset> = {
  'pavilion-night': {
    id: 'pavilion-night',
    name: '子虚亭 · 夜亭',
    chromeBg: '#132429',
    panelBg: '#162b30',
    canvasBg: '#0e1d21',
    border: 'rgba(135, 209, 181, 0.14)',
    ink: '#e8f1ee',
    muted: '#8da9a4',
    accent: '#87d1b5',
    xterm: {
      background: '#0e1d21',
      foreground: '#e4efe9',
      cursor: '#87d1b5',
      cursorAccent: '#0e1d21',
      selectionBackground: 'rgba(135, 209, 181, 0.28)',
      black: '#1a2f34',
      red: '#e27d7d',
      green: '#87d1b5',
      yellow: '#e6bb70',
      blue: '#7ab4d8',
      magenta: '#c99bd8',
      cyan: '#6ec7c1',
      white: '#d9e7e3',
      brightBlack: '#5a7874',
      brightRed: '#f29898',
      brightGreen: '#a3e4cc',
      brightYellow: '#f2cf8c',
      brightBlue: '#97caea',
      brightMagenta: '#dfb5eb',
      brightCyan: '#8fded9',
      brightWhite: '#f5faf8',
    },
  },
  'pavilion-day': {
    id: 'pavilion-day',
    name: '子虚亭 · 月白',
    light: true,
    chromeBg: '#ece6da',
    panelBg: '#f4efe5',
    canvasBg: '#fbf8f1',
    border: 'rgba(38, 57, 54, 0.14)',
    ink: '#223633',
    muted: '#5e736e',
    accent: '#2a6657',
    xterm: {
      background: '#fbf8f1',
      foreground: '#223633',
      cursor: '#2a6657',
      cursorAccent: '#fbf8f1',
      selectionBackground: 'rgba(42, 102, 87, 0.2)',
      black: '#243835',
      red: '#b83d46',
      green: '#2a6657',
      yellow: '#9c6e24',
      blue: '#2a628f',
      magenta: '#7c4d8c',
      cyan: '#1f7476',
      white: '#dfd8ca',
      brightBlack: '#6b7e79',
      brightRed: '#cf4e57',
      brightGreen: '#37826f',
      brightYellow: '#b4822e',
      brightBlue: '#3b7aad',
      brightMagenta: '#9462a6',
      brightCyan: '#298e91',
      brightWhite: '#ffffff',
    },
  },
  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    chromeBg: '#16161e',
    panelBg: '#1a1b26',
    canvasBg: '#1a1b26',
    border: 'rgba(192, 202, 245, 0.12)',
    ink: '#c0caf5',
    muted: '#787c99',
    accent: '#7aa2f7',
    xterm: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: 'rgba(122, 162, 247, 0.28)',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
  },
  dracula: {
    id: 'dracula',
    name: 'Dracula',
    chromeBg: '#21222c',
    panelBg: '#282a36',
    canvasBg: '#282a36',
    border: 'rgba(248, 248, 242, 0.12)',
    ink: '#f8f8f2',
    muted: '#94a0c4',
    accent: '#bd93f9',
    xterm: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: 'rgba(189, 147, 249, 0.28)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    chromeBg: '#262b36',
    panelBg: '#2e3440',
    canvasBg: '#2e3440',
    border: 'rgba(216, 222, 233, 0.12)',
    ink: '#eceff4',
    muted: '#9aa7bc',
    accent: '#88c0d0',
    xterm: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: 'rgba(136, 192, 208, 0.28)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  'one-dark': {
    id: 'one-dark',
    name: 'One Dark',
    chromeBg: '#21252b',
    panelBg: '#282c34',
    canvasBg: '#282c34',
    border: 'rgba(171, 178, 191, 0.12)',
    ink: '#abb2bf',
    muted: '#7f848e',
    accent: '#61afef',
    xterm: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: 'rgba(97, 175, 239, 0.26)',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdfe4',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    },
  },
};

export interface TerminalPreferences {
  theme: TerminalThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPreferences = {
  theme: 'pavilion-night',
  fontFamily: DEFAULT_NERD_FONT_STACK,
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
};

const PREFS_KEY = 'fable-terminal-prefs-v1';
const SNIPPETS_KEY = 'fable-terminal-snippets-v1';

export interface TerminalSnippet {
  id: string;
  title: string;
  command: string;
  runImmediately: boolean;
  builtin?: boolean;
}

export const BUILTIN_SNIPPETS: TerminalSnippet[] = [
  { id: 'builtin-trz', title: 'trz 上传文件', command: 'trz', runImmediately: true, builtin: true },
  { id: 'builtin-tsz', title: 'tsz 下载文件（补全文件名）', command: 'tsz ', runImmediately: false, builtin: true },
  { id: 'builtin-rz', title: 'rz (lrzsz 上传)', command: 'rz', runImmediately: true, builtin: true },
  { id: 'builtin-ports', title: '查看本机监听端口', command: 'ss -tulpn 2>/dev/null || netstat -ano', runImmediately: true, builtin: true },
  { id: 'builtin-git', title: 'Git 状态概览', command: 'git status -sb', runImmediately: true, builtin: true },
];

export function loadTerminalPrefs(): TerminalPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_TERMINAL_PREFS };
    const parsed = JSON.parse(raw) as Partial<TerminalPreferences>;
    return {
      theme: parsed.theme && parsed.theme in TERMINAL_THEMES ? parsed.theme : DEFAULT_TERMINAL_PREFS.theme,
      fontFamily:
        typeof parsed.fontFamily === 'string' && parsed.fontFamily.trim()
          ? parsed.fontFamily
          : DEFAULT_TERMINAL_PREFS.fontFamily,
      fontSize:
        typeof parsed.fontSize === 'number' && Number.isFinite(parsed.fontSize)
          ? Math.max(10, Math.min(26, Math.round(parsed.fontSize)))
          : DEFAULT_TERMINAL_PREFS.fontSize,
      lineHeight:
        typeof parsed.lineHeight === 'number' && Number.isFinite(parsed.lineHeight)
          ? Math.max(1.0, Math.min(1.6, Number(parsed.lineHeight.toFixed(2))))
          : DEFAULT_TERMINAL_PREFS.lineHeight,
      cursorStyle:
        parsed.cursorStyle === 'bar' || parsed.cursorStyle === 'underline' ? parsed.cursorStyle : 'block',
      cursorBlink: typeof parsed.cursorBlink === 'boolean' ? parsed.cursorBlink : true,
      copyOnSelect: typeof parsed.copyOnSelect === 'boolean' ? parsed.copyOnSelect : false,
    };
  } catch {
    return { ...DEFAULT_TERMINAL_PREFS };
  }
}

export function saveTerminalPrefs(prefs: TerminalPreferences) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Ignore storage quota errors. */
  }
}

export function loadUserSnippets(): TerminalSnippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is TerminalSnippet =>
        item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.command === 'string',
    );
  } catch {
    return [];
  }
}

export function saveUserSnippets(snippets: TerminalSnippet[]) {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  } catch {
    /* Ignore storage quota errors. */
  }
}
