import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import type { TerminalSessionSummary } from '../../shared/plugins';
import { ZmodemFilter, type TerminalTransferProgress } from './zmodem';
import { TrzszFilter } from './trzsz';
import { TerminalSequenceFilter, type TerminalCapturedImage } from './kitty-graphics';
import { TERMINAL_THEMES, type TerminalPreferences } from './terminal-prefs';

export interface TerminalPaneRuntime {
  session: TerminalSessionSummary;
  title: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  zmodem: ZmodemFilter;
  trzsz: TrzszFilter;
  sequences: TerminalSequenceFilter;
  container: HTMLDivElement;
  feed: (chunk: Uint8Array) => void;
  applyPrefs: (prefs: TerminalPreferences) => void;
  exportTranscript: () => string;
  dispose: () => void;
}

const encoder = new TextEncoder();

export function createTerminalPane(opts: {
  session: TerminalSessionSummary;
  getPrefs: () => TerminalPreferences;
  allowOsc52: () => boolean;
  transformInput: (text: string) => string;
  sendBytes: (sessionId: string, bytes: Uint8Array) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  onProgress: (progress: TerminalTransferProgress | null) => void;
  onDownloadFile: (name: string, data: Uint8Array) => void;
  onRequestUploadFiles: () => Promise<File[]>;
  onImage: (img: TerminalCapturedImage) => void;
  onNotify: (message: string) => void;
  onMetaChange: () => void;
}): TerminalPaneRuntime {
  const { session } = opts;
  const prefs = opts.getPrefs();
  const preset = TERMINAL_THEMES[prefs.theme] ?? TERMINAL_THEMES['pavilion-night'];

  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '100%';

  const term = new Terminal({
    cursorBlink: prefs.cursorBlink,
    cursorStyle: prefs.cursorStyle,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    fontFamily: prefs.fontFamily,
    allowProposedApi: true,
    scrollback: 10000,
    theme: preset.xterm,
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  const webLinks = new WebLinksAddon();
  const unicode11 = new Unicode11Addon();
  const imageAddon = new ImageAddon({
    sixelSupport: true,
    sixelScrolling: true,
    iipSupport: true,
    enableSizeReports: true,
  });
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(webLinks);
  term.loadAddon(unicode11);
  term.loadAddon(imageAddon);
  term.unicode.activeVersion = '11';

  const send = (bytes: Uint8Array) => opts.sendBytes(session.id, bytes);
  const zmodem = new ZmodemFilter({
    sendBytes: send,
    onProgress: opts.onProgress,
    onDownloadFile: opts.onDownloadFile,
    onRequestUploadFiles: opts.onRequestUploadFiles,
  });
  const trzsz = new TrzszFilter({
    sendBytes: send,
    onProgress: opts.onProgress,
    onDownloadFile: opts.onDownloadFile,
    onRequestUploadFiles: opts.onRequestUploadFiles,
  });
  const sequences = new TerminalSequenceFilter({
    sendReply: send,
    onImage: opts.onImage,
    onClipboardWrite: (text) => {
      if (!opts.allowOsc52()) return;
      void navigator.clipboard?.writeText(text).then(
        () => opts.onNotify('已通过 OSC 52 同步到剪贴板'),
        () => {},
      );
    },
    onCwdChange: (cwd) => {
      pane.cwd = cwd;
      opts.onMetaChange();
    },
  });

  const pane: TerminalPaneRuntime = {
    session,
    title: session.title || '终端',
    cwd: session.cwd,
    term,
    fit,
    search,
    zmodem,
    trzsz,
    sequences,
    container,
    feed(chunk: Uint8Array) {
      if (!chunk.length) return;
      const afterZ = zmodem.process(chunk);
      if (!afterZ.length) return;
      const afterT = trzsz.process(afterZ);
      if (!afterT.length) return;
      const afterSeq = sequences.process(afterT);
      if (afterSeq.length) term.write(afterSeq);
    },
    applyPrefs(next: TerminalPreferences) {
      const nextPreset = TERMINAL_THEMES[next.theme] ?? TERMINAL_THEMES['pavilion-night'];
      term.options.theme = nextPreset.xterm;
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.lineHeight = next.lineHeight;
      term.options.cursorStyle = next.cursorStyle;
      term.options.cursorBlink = next.cursorBlink;
      try {
        fit.fit();
      } catch {
        /* Ignore resize while detached. */
      }
    },
    exportTranscript() {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      return `${lines.join('\n')}\n`;
    },
    dispose() {
      zmodem.cancel();
      trzsz.cancel();
      term.dispose();
    },
  };

  term.onTitleChange((title) => {
    if (title.trim()) {
      pane.title = title.trim();
      opts.onMetaChange();
    }
  });

  term.onSelectionChange(() => {
    if (!opts.getPrefs().copyOnSelect || !term.hasSelection()) return;
    const text = term.getSelection();
    if (text) {
      void navigator.clipboard?.writeText(text).catch(() => {});
    }
  });

  term.onData((text) => {
    const payload = opts.transformInput(text);
    opts.sendBytes(session.id, encoder.encode(payload));
  });

  term.onBinary((bin) => {
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    opts.sendBytes(session.id, bytes);
  });

  term.onResize(({ cols, rows }) => {
    opts.sendResize(session.id, cols, rows);
  });

  return pane;
}
