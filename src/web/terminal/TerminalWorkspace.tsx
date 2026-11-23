import { onScopeDispose, shallowRef, type CSSProperties } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender } from '../render-effects';
import { deviceSession } from '../device-session';
import type { AppRoute } from '../shell/routes';
import { appPixels, appViewport, useAppZoom } from '../shell/app-zoom';
import { Icon } from '../Icon';
import {
  TERMINAL_BACKEND_ID,
  type PluginManagementSnapshot,
  type TerminalHostCapabilities,
  type TerminalPluginSettings,
  type TerminalSessionSummary,
  type TerminalShellOption,
} from '../../shared/plugins';
import type { TerminalTransferProgress } from './zmodem';
import type { TerminalCapturedImage } from './kitty-graphics';
import { formatTransferBytes } from './shell-escape';
import {
  loadTerminalPrefs,
  saveTerminalPrefs,
  TERMINAL_THEMES,
  type TerminalPreferences,
} from './terminal-prefs';
import { createTerminalPane, type TerminalPaneRuntime } from './terminal-pane';
import { TerminalPrefsPopover } from './TerminalPrefsPopover';
import { TerminalSidePanel, type SidePanelTab } from './TerminalSidePanel';
import './terminal.css';

type SplitLayout = 'single' | 'horizontal' | 'vertical';

interface TerminalTab {
  id: string;
  customTitle: string;
  layout: SplitLayout;
  splitRatio: number;
  panes: TerminalPaneRuntime[];
  activePaneId: string;
}

const encoder = new TextEncoder();

export default tsxComponent(function TerminalWorkspace(_props: {
  active: boolean;
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
}) {
  const paneAreaRef = shallowRef<HTMLDivElement | null>(null);
  const filePickerRef = shallowRef<HTMLInputElement | null>(null);

  const tabs = shallowRef<TerminalTab[]>([]);
  const activeTabId = shallowRef('');
  const renamingTabId = shallowRef('');
  const renameDraft = shallowRef('');

  const shells = shallowRef<TerminalShellOption[]>([]);
  const selectedShell = shallowRef('');
  const settings = shallowRef<TerminalPluginSettings | null>(null);
  const capabilities = shallowRef<TerminalHostCapabilities | null>(null);
  const disabledMessage = shallowRef('');
  const loading = shallowRef(true);

  const prefs = shallowRef<TerminalPreferences>(loadTerminalPrefs());
  const newMenuOpen = shallowRef(false);
  const prefsOpen = shallowRef(false);
  const searchOpen = shallowRef(false);
  const searchQuery = shallowRef('');
  const sidePanelOpen = shallowRef(false);
  const sidePanelTab = shallowRef<SidePanelTab>('files');
  const zenMode = shallowRef(false);
  const keybarOpen = shallowRef(typeof window !== 'undefined' && window.innerWidth < 820);
  const ctrlArmed = shallowRef(false);
  const altArmed = shallowRef(false);
  const draggingFile = shallowRef(false);
  const splittingDrag = shallowRef(false);
  const transfer = shallowRef<TerminalTransferProgress | null>(null);
  const images = shallowRef<TerminalCapturedImage[]>([]);
  const lightboxImage = shallowRef<TerminalCapturedImage | null>(null);
  const toast = shallowRef('');
  const newTabX11 = shallowRef(false);
  const newTabWayland = shallowRef(false);
  const contextMenu = shallowRef<{ paneId: string; style: CSSProperties } | null>(null);
  const { scale: appZoomScale } = useAppZoom();

  let uploadTargetDir: string | undefined;
  let pendingTransferFileResolve: ((files: File[]) => void) | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let tabSeq = 1;

  const watchInit = watchRender();
  const watchResizeArea = watchRender();
  const watchPrefs = watchRender();
  const watchZoom = watchRender();

  function notify(message: string) {
    toast.value = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast.value === message) toast.value = '';
    }, 3000);
  }

  function currentTab(): TerminalTab | undefined {
    return tabs.value.find((tab) => tab.id === activeTabId.value) ?? tabs.value[0];
  }

  function currentPane(): TerminalPaneRuntime | undefined {
    const tab = currentTab();
    if (!tab) return undefined;
    return tab.panes.find((p) => p.session.id === tab.activePaneId) ?? tab.panes[0];
  }

  function findPaneBySession(sessionId: string): { tab: TerminalTab; pane: TerminalPaneRuntime } | undefined {
    for (const tab of tabs.value) {
      const pane = tab.panes.find((p) => p.session.id === sessionId);
      if (pane) return { tab, pane };
    }
    return undefined;
  }

  function touchTabs() {
    tabs.value = [...tabs.value];
  }

  function sendRawInput(sessionId: string, bytes: Uint8Array) {
    if (!bytes.length) return;
    void deviceSession.terminalRequest('terminal-input', { sessionId }, bytes).catch(() => {});
  }

  function fitActiveTabPanes() {
    const tab = currentTab();
    if (!tab) return;
    for (const pane of tab.panes) {
      try {
        if (pane.term.element) pane.fit.fit();
      } catch {
        /* Ignore fit while hidden. */
      }
    }
  }

  function bindPaneHost(pane: TerminalPaneRuntime, el: HTMLDivElement | null) {
    if (!el) return;
    if (pane.container.parentElement !== el) {
      el.replaceChildren(pane.container);
    }
    if (!pane.term.element) {
      pane.term.open(pane.container);
    }
    requestAnimationFrame(() => {
      try {
        pane.fit.fit();
      } catch {
        /* Ignore initial layout race. */
      }
      if (currentPane()?.session.id === pane.session.id) {
        pane.term.focus();
      }
    });
  }

  function triggerDownload(name: string, data: Uint8Array) {
    const blob = new Blob([data as Uint8Array<ArrayBuffer>]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'download.bin';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify(`已保存 ${name}（${formatTransferBytes(data.byteLength)}）`);
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          images.value = [
            ...images.value.slice(-19),
            {
              id: `dl-${Date.now()}`,
              protocol: 'iterm2',
              mime: 'image/*',
              dataUrl: reader.result,
              name,
              timestamp: Date.now(),
            },
          ];
        }
      };
      reader.readAsDataURL(blob);
    }
  }

  function requestUploadFiles(): Promise<File[]> {
    return new Promise((resolve) => {
      const input = filePickerRef.value;
      if (!input) {
        resolve([]);
        return;
      }
      pendingTransferFileResolve = resolve;
      uploadTargetDir = undefined;
      input.value = '';
      input.click();
    });
  }

  function buildPane(session: TerminalSessionSummary): TerminalPaneRuntime {
    return createTerminalPane({
      session,
      getPrefs: () => prefs.value,
      allowOsc52: () => settings.value?.allowOsc52Clipboard !== false,
      transformInput: (text) => {
        let payload = text;
        if (ctrlArmed.value && text.length === 1) {
          const code = text.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) payload = String.fromCharCode(code - 64);
          ctrlArmed.value = false;
        } else if (altArmed.value) {
          payload = `\x1b${text}`;
          altArmed.value = false;
        }
        return payload;
      },
      sendBytes: sendRawInput,
      sendResize: (sessionId, cols, rows) => {
        void deviceSession.terminalRequest('terminal-resize', { sessionId, cols, rows }).catch(() => {});
      },
      onProgress: (p) => {
        transfer.value = p;
      },
      onDownloadFile: triggerDownload,
      onRequestUploadFiles: requestUploadFiles,
      onImage: (img) => {
        images.value = [...images.value.slice(-19), img];
      },
      onNotify: notify,
      onMetaChange: touchTabs,
    });
  }

  async function requestNewSession(shell?: string, cwd?: string): Promise<TerminalSessionSummary> {
    const active = currentPane();
    const res = (await deviceSession.api(
      '/api/terminal/sessions',
      {
        method: 'POST',
        body: JSON.stringify({
          shell: shell !== undefined ? shell || undefined : selectedShell.value || undefined,
          cwd: cwd || undefined,
          cols: active?.term.cols || 100,
          rows: active?.term.rows || 30,
          enableX11: newTabX11.value,
          enableWayland: newTabWayland.value,
        }),
      },
      TERMINAL_BACKEND_ID,
    )) as { session: TerminalSessionSummary };
    return res.session;
  }

  async function attachPane(pane: TerminalPaneRuntime) {
    const { bytes } = await deviceSession.terminalRequest('terminal-attach', {
      sessionId: pane.session.id,
    });
    if (bytes && bytes.length) {
      pane.feed(bytes);
    }
  }

  async function attachSessionAsTab(session: TerminalSessionSummary) {
    const existing = findPaneBySession(session.id);
    if (existing) {
      activeTabId.value = existing.tab.id;
      existing.tab.activePaneId = existing.pane.session.id;
      touchTabs();
      return;
    }
    const pane = buildPane(session);
    const tab: TerminalTab = {
      id: `tab-${tabSeq++}`,
      customTitle: '',
      layout: 'single',
      splitRatio: 0.5,
      panes: [pane],
      activePaneId: session.id,
    };
    tabs.value = [...tabs.value, tab];
    activeTabId.value = tab.id;
    await attachPane(pane);
  }

  async function createNewTab(shell?: string) {
    try {
      const session = await requestNewSession(shell);
      await attachSessionAsTab(session);
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法新建终端会话');
    }
  }

  async function splitCurrentTab(direction: 'horizontal' | 'vertical') {
    const tab = currentTab();
    if (!tab) {
      await createNewTab();
      return;
    }
    if (tab.panes.length >= 2) {
      tab.layout = direction;
      touchTabs();
      requestAnimationFrame(fitActiveTabPanes);
      return;
    }
    try {
      const source = currentPane();
      const session = await requestNewSession(undefined, source?.cwd);
      const pane = buildPane(session);
      tab.panes = [...tab.panes, pane];
      tab.layout = direction;
      tab.splitRatio = 0.5;
      tab.activePaneId = session.id;
      touchTabs();
      await attachPane(pane);
      requestAnimationFrame(fitActiveTabPanes);
    } catch (error) {
      notify(error instanceof Error ? error.message : '分屏失败');
    }
  }

  async function restartPane(paneId: string) {
    const found = findPaneBySession(paneId);
    if (!found) return;
    const { tab, pane: oldPane } = found;
    try {
      const session = await requestNewSession(undefined, oldPane.cwd);
      const nextPane = buildPane(session);
      const idx = tab.panes.findIndex((p) => p.session.id === paneId);
      oldPane.dispose();
      void deviceSession
        .api(`/api/terminal/sessions/${encodeURIComponent(paneId)}/close`, { method: 'POST', body: '{}' }, TERMINAL_BACKEND_ID)
        .catch(() => {});
      if (idx >= 0) tab.panes[idx] = nextPane;
      if (tab.activePaneId === paneId) tab.activePaneId = session.id;
      touchTabs();
      await attachPane(nextPane);
    } catch (error) {
      notify(error instanceof Error ? error.message : '重启会话失败');
    }
  }

  function closePane(paneId: string) {
    const found = findPaneBySession(paneId);
    if (!found) return;
    const { tab, pane } = found;
    pane.dispose();
    void deviceSession
      .api(`/api/terminal/sessions/${encodeURIComponent(paneId)}/close`, { method: 'POST', body: '{}' }, TERMINAL_BACKEND_ID)
      .catch(() => {});
    tab.panes = tab.panes.filter((p) => p.session.id !== paneId);
    if (!tab.panes.length) {
      const idx = tabs.value.findIndex((t) => t.id === tab.id);
      tabs.value = tabs.value.filter((t) => t.id !== tab.id);
      if (activeTabId.value === tab.id) {
        activeTabId.value = tabs.value[Math.max(0, idx - 1)]?.id ?? '';
      }
      return;
    }
    tab.layout = 'single';
    tab.activePaneId = tab.panes[0].session.id;
    touchTabs();
    requestAnimationFrame(fitActiveTabPanes);
  }

  function closeTab(tabId: string) {
    const idx = tabs.value.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const tab = tabs.value[idx];
    for (const pane of tab.panes) {
      pane.dispose();
      void deviceSession
        .api(`/api/terminal/sessions/${encodeURIComponent(pane.session.id)}/close`, { method: 'POST', body: '{}' }, TERMINAL_BACKEND_ID)
        .catch(() => {});
    }
    tabs.value = tabs.value.filter((t) => t.id !== tabId);
    if (activeTabId.value === tabId) {
      activeTabId.value = tabs.value[Math.max(0, idx - 1)]?.id ?? '';
    }
  }

  async function uploadFilesToSession(files: File[], directory?: string) {
    const pane = currentPane();
    if (!pane || !files.length) return;
    const targetDir = directory || pane.cwd || undefined;
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        notify(`正在上传 ${file.name}…`);
        const { value } = await deviceSession.rpcBinary<{
          name: string;
          path: string;
          shellPath: string;
          size: number;
        }>(
          `/api/terminal/sessions/${encodeURIComponent(pane.session.id)}/upload`,
          'POST',
          { name: file.name, directory: targetDir },
          bytes,
          TERMINAL_BACKEND_ID,
          60000,
        );
        sendRawInput(pane.session.id, encoder.encode(`${value.shellPath} `));
        notify(`已上传到 ${value.path}`);
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              images.value = [
                ...images.value.slice(-19),
                {
                  id: `up-${Date.now()}`,
                  protocol: 'iterm2',
                  mime: file.type,
                  dataUrl: reader.result,
                  name: value.name,
                  timestamp: Date.now(),
                },
              ];
            }
          };
          reader.readAsDataURL(file);
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : `上传 ${file.name} 失败`);
      }
    }
  }

  async function updateHostSettings(patch: Partial<TerminalPluginSettings>) {
    if (!settings.value) return;
    const merged: TerminalPluginSettings = { ...settings.value, ...patch };
    try {
      const snap = (await deviceSession.api('/api/plugins/manage/builtin', {
        method: 'POST',
        body: JSON.stringify({ id: 'terminal', config: merged }),
      })) as PluginManagementSnapshot;
      const terminal = snap.builtins?.find((item) => item.id === 'terminal');
      settings.value = terminal?.config ?? merged;
      if (terminal?.hostCapabilities) capabilities.value = terminal.hostCapabilities;
      notify('已更新宿主机转发权限');
    } catch (error) {
      notify(error instanceof Error ? error.message : '更新宿主机配置失败');
    }
  }

  function exportCurrentTranscript() {
    const pane = currentPane();
    if (!pane) return;
    const text = pane.exportTranscript();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terminal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify('已导出终端记录');
  }

  function startSplitterDrag(event: PointerEvent, tab: TerminalTab) {
    const area = paneAreaRef.value;
    if (!area) return;
    event.preventDefault();
    splittingDrag.value = true;
    const onMove = (ev: PointerEvent) => {
      const rect = area.getBoundingClientRect();
      const raw =
        tab.layout === 'horizontal'
          ? (ev.clientX - rect.left) / Math.max(1, rect.width)
          : (ev.clientY - rect.top) / Math.max(1, rect.height);
      tab.splitRatio = Math.max(0.2, Math.min(0.8, Number(raw.toFixed(3))));
      touchTabs();
      fitActiveTabPanes();
    };
    const onUp = () => {
      splittingDrag.value = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      fitActiveTabPanes();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function disposeAllTabs() {
    for (const tab of tabs.value) {
      for (const pane of tab.panes) pane.dispose();
    }
    tabs.value = [];
    activeTabId.value = '';
  }

  onScopeDispose(() => {
    clearTimeout(toastTimer);
    disposeAllTabs();
  });

  return ({ active, navigate }) => {
    watchInit(() => {
      if (!active) return;
      let alive = true;
      const stopEvents = deviceSession.onTerminalEvent((event, bytes) => {
        const found = findPaneBySession(event.sessionId);
        if (!found) return;
        const { pane } = found;
        if (event.type === 'terminal-output' && bytes) {
          pane.feed(bytes);
        } else if (event.type === 'terminal-exit') {
          pane.session = { ...pane.session, running: false, exitCode: event.exitCode ?? null };
          pane.term.writeln(`\r\n\x1b[90m[进程已退出，退出码: ${event.exitCode ?? '未知'}]\x1b[0m`);
          touchTabs();
        }
      });

      const onKeydown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
          const key = event.key.toLowerCase();
          if (key === 'f') {
            event.preventDefault();
            searchOpen.value = !searchOpen.value;
          } else if (key === 'd') {
            event.preventDefault();
            void splitCurrentTab('horizontal');
          } else if (key === 'e') {
            event.preventDefault();
            void splitCurrentTab('vertical');
          }
        } else if (event.key === 'Escape') {
          if (contextMenu.value) contextMenu.value = null;
          else if (newMenuOpen.value) newMenuOpen.value = false;
          else if (prefsOpen.value) prefsOpen.value = false;
          else if (searchOpen.value) searchOpen.value = false;
          else if (lightboxImage.value) lightboxImage.value = null;
          else if (zenMode.value) zenMode.value = false;
        }
      };

      const onPaste = (event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        const pastedImages: File[] = [];
        for (const item of items) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              const ext = file.type.split('/')[1] || 'png';
              pastedImages.push(
                file.name && file.name !== 'image.png'
                  ? file
                  : new File([file], `pasted-${Date.now()}.${ext}`, { type: file.type }),
              );
            }
          }
        }
        if (pastedImages.length) {
          event.preventDefault();
          void uploadFilesToSession(pastedImages);
        }
      };

      window.addEventListener('keydown', onKeydown);
      window.addEventListener('paste', onPaste);

      loading.value = true;
      disabledMessage.value = '';
      void deviceSession
        .api('/api/terminal/sessions', { method: 'GET' }, TERMINAL_BACKEND_ID)
        .then(async (raw) => {
          if (!alive) return;
          const res = raw as {
            sessions?: TerminalSessionSummary[];
            status?: {
              settings?: TerminalPluginSettings;
              capabilities?: TerminalHostCapabilities;
              shells?: TerminalShellOption[];
            };
          };
          const st = res.status;
          settings.value = st?.settings ?? null;
          capabilities.value = st?.capabilities ?? null;
          shells.value = st?.shells ?? [];
          if (!selectedShell.value && shells.value.length) {
            selectedShell.value = st?.settings?.defaultShell || '';
          }
          const existing = (res.sessions ?? []).filter((s) => s.running);
          if (existing.length) {
            for (const session of existing) await attachSessionAsTab(session);
          } else {
            await createNewTab();
          }
        })
        .catch((error) => {
          if (!alive) return;
          disabledMessage.value = error instanceof Error ? error.message : '终端插件未启用或电脑暂未连接';
        })
        .finally(() => {
          if (alive) loading.value = false;
        });

      return () => {
        alive = false;
        stopEvents();
        window.removeEventListener('keydown', onKeydown);
        window.removeEventListener('paste', onPaste);
      };
    }, [active, deviceSession.host?.hostId]);

    const activeTab = currentTab();
    const activePane = currentPane();

    watchResizeArea(() => {
      const area = paneAreaRef.value;
      if (!area) return;
      const observer = new ResizeObserver(() => fitActiveTabPanes());
      observer.observe(area);
      requestAnimationFrame(fitActiveTabPanes);
      return () => observer.disconnect();
    }, [paneAreaRef.value, activeTab?.id, activeTab?.layout, activeTab?.panes.length, sidePanelOpen.value, zenMode.value, keybarOpen.value, active]);

    watchPrefs(() => {
      saveTerminalPrefs(prefs.value);
      for (const tab of tabs.value) {
        for (const pane of tab.panes) {
          pane.applyPrefs(prefs.value);
        }
      }
    }, [prefs.value]);
    watchZoom(() => {
      contextMenu.value = null;
    }, [appZoomScale.value]);

    const theme = TERMINAL_THEMES[prefs.value.theme] ?? TERMINAL_THEMES['pavilion-night'];
    const themeVars = `--t-chrome:${theme.chromeBg};--t-panel:${theme.panelBg};--t-canvas:${theme.canvasBg};--t-border:${theme.border};--t-ink:${theme.ink};--t-muted:${theme.muted};--t-accent:${theme.accent}`;

    if (disabledMessage.value) {
      return (
        <main class={`term-ws${theme.light ? ' light' : ''}`} style={themeVars}>
          <div class="term-disabled-card">
            <Icon name="terminal" size={32} />
            <h2 style="margin:0;font-size:17px">终端插件当前不可用</h2>
            <p class="term-side-hint">{disabledMessage.value}</p>
            <div style="display:flex;gap:10px">
              <button type="button" class="term-action-btn primary" onClick={() => navigate({ page: 'plugins' })}>
                前往插件管理开启
              </button>
              <button type="button" class="term-action-btn" onClick={() => navigate({ page: 'workbench' })}>
                返回工作台
              </button>
            </div>
          </div>
        </main>
      );
    }

    const closePopovers = () => {
      if (newMenuOpen.value) newMenuOpen.value = false;
      if (prefsOpen.value) prefsOpen.value = false;
      if (contextMenu.value) contextMenu.value = null;
    };

    const ctxPane = contextMenu.value ? findPaneBySession(contextMenu.value.paneId)?.pane : undefined;

    return (
      <main
        class={`term-ws${theme.light ? ' light' : ''}${zenMode.value ? ' term-zen' : ''}`}
        style={themeVars}
        onClick={closePopovers}
        onDragover={(event) => {
          event.preventDefault();
          draggingFile.value = true;
        }}
        onDragleave={() => {
          draggingFile.value = false;
        }}
        onDrop={(event) => {
          event.preventDefault();
          draggingFile.value = false;
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length) void uploadFilesToSession(files);
        }}
      >
        <input
          ref={filePickerRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            const picked = Array.from(input.files ?? []);
            if (pendingTransferFileResolve) {
              const fn = pendingTransferFileResolve;
              pendingTransferFileResolve = null;
              fn(picked);
            } else if (picked.length) {
              const dir = uploadTargetDir;
              uploadTargetDir = undefined;
              void uploadFilesToSession(picked, dir);
            }
          }}
        />

        <header class="term-chrome">
          <button
            type="button"
            class="term-icon-btn"
            aria-label={zenMode.value ? '退出专注全屏' : '返回工作台'}
            title={zenMode.value ? '退出专注全屏 (Esc)' : '返回工作台'}
            onClick={() => {
              if (zenMode.value) zenMode.value = false;
              else navigate({ page: 'workbench' });
            }}
          >
            <Icon name="back" size={16} />
          </button>

          <div class="term-tabs" role="tablist" aria-label="终端标签页">
            {tabs.value.map((tab) => {
              const lead = tab.panes.find((p) => p.session.id === tab.activePaneId) ?? tab.panes[0];
              const running = tab.panes.some((p) => p.session.running);
              const label = tab.customTitle || lead?.title || '终端';
              const isRenaming = renamingTabId.value === tab.id;
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={tab.id === activeTab?.id}
                  class={`term-tab${tab.id === activeTab?.id ? ' active' : ''}`}
                  onClick={() => {
                    activeTabId.value = tab.id;
                  }}
                  onDblclick={() => {
                    renamingTabId.value = tab.id;
                    renameDraft.value = label;
                  }}
                >
                  <i class={`term-tab-dot${running ? '' : ' exited'}`} aria-hidden="true" />
                  {isRenaming ? (
                    <input
                      type="text"
                      class="term-tab-rename"
                      value={renameDraft.value}
                      onClick={(e) => e.stopPropagation()}
                      onInput={(e) => {
                        renameDraft.value = (e.currentTarget as HTMLInputElement).value;
                      }}
                      onBlur={() => {
                        tab.customTitle = renameDraft.value.trim();
                        renamingTabId.value = '';
                        touchTabs();
                      }}
                      onKeydown={(e) => {
                        if (e.key === 'Enter') {
                          tab.customTitle = renameDraft.value.trim();
                          renamingTabId.value = '';
                          touchTabs();
                        } else if (e.key === 'Escape') {
                          renamingTabId.value = '';
                        }
                      }}
                    />
                  ) : (
                    <span class="term-tab-title" title="双击重命名标签页">
                      {label}
                      {tab.panes.length > 1 ? ' · 分屏' : ''}
                    </span>
                  )}
                  <button
                    type="button"
                    class="term-tab-close"
                    aria-label={`关闭 ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              );
            })}
          </div>

          <div class="term-split-new" onClick={(e) => e.stopPropagation()}>
            <button type="button" title="新建终端标签页" aria-label="新建终端标签页" onClick={() => void createNewTab()}>
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              title="选择 Shell / 分屏 / 显示转发"
              aria-label="更多新建选项"
              onClick={() => {
                prefsOpen.value = false;
                newMenuOpen.value = !newMenuOpen.value;
              }}
            >
              <Icon name="down" size={12} />
            </button>

            {newMenuOpen.value && (
              <div class="term-popover term-new-menu" role="menu">
                <div class="term-menu-label">新建会话（Shell）</div>
                <button
                  type="button"
                  class={`term-menu-item${selectedShell.value === '' ? ' active' : ''}`}
                  onClick={() => {
                    selectedShell.value = '';
                    newMenuOpen.value = false;
                    void createNewTab('');
                  }}
                >
                  <span>默认 Shell</span>
                </button>
                {shells.value.map((sh) => (
                  <button
                    key={sh.path}
                    type="button"
                    class={`term-menu-item${selectedShell.value === sh.path ? ' active' : ''}`}
                    onClick={() => {
                      selectedShell.value = sh.path;
                      newMenuOpen.value = false;
                      void createNewTab(sh.path);
                    }}
                  >
                    <span>{sh.name}</span>
                  </button>
                ))}
                <div class="term-menu-sep" />
                <button
                  type="button"
                  class="term-menu-item"
                  onClick={() => {
                    newMenuOpen.value = false;
                    void splitCurrentTab('horizontal');
                  }}
                >
                  <span>
                    <Icon name="splitH" size={13} /> 向右分屏
                  </span>
                  <kbd>Ctrl+Shift+D</kbd>
                </button>
                <button
                  type="button"
                  class="term-menu-item"
                  onClick={() => {
                    newMenuOpen.value = false;
                    void splitCurrentTab('vertical');
                  }}
                >
                  <span>
                    <Icon name="splitV" size={13} /> 向下分屏
                  </span>
                  <kbd>Ctrl+Shift+E</kbd>
                </button>
                {(settings.value?.allowX11Forwarding ||
                  (settings.value?.allowWaylandForwarding && activePane?.session.platform !== 'windows')) && (
                  <>
                    <div class="term-menu-sep" />
                    <div class="term-menu-label">新建会话显示转发</div>
                    {settings.value?.allowX11Forwarding && (
                      <button
                        type="button"
                        class={`term-menu-item${newTabX11.value ? ' active' : ''}`}
                        onClick={() => {
                          newTabX11.value = !newTabX11.value;
                        }}
                      >
                        <span>注入 X11 转发</span>
                        <kbd>{newTabX11.value ? '开' : '关'}</kbd>
                      </button>
                    )}
                    {settings.value?.allowWaylandForwarding && activePane?.session.platform !== 'windows' && (
                      <button
                        type="button"
                        class={`term-menu-item${newTabWayland.value ? ' active' : ''}`}
                        onClick={() => {
                          newTabWayland.value = !newTabWayland.value;
                        }}
                      >
                        <span>注入 Wayland 转发</span>
                        <kbd>{newTabWayland.value ? '开' : '关'}</kbd>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div class="term-chrome-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              class={`term-icon-btn${activeTab && activeTab.panes.length > 1 ? ' active' : ''}`}
              title={
                activeTab && activeTab.panes.length > 1
                  ? activeTab.layout === 'horizontal'
                    ? '切换为上下分屏'
                    : '切换为左右分屏'
                  : '向右分屏 (Ctrl+Shift+D)'
              }
              aria-label="分屏"
              onClick={() =>
                void splitCurrentTab(
                  activeTab && activeTab.panes.length > 1 && activeTab.layout === 'horizontal'
                    ? 'vertical'
                    : 'horizontal',
                )
              }
            >
              <Icon
                name={activeTab?.layout === 'vertical' ? 'splitV' : 'splitH'}
                size={15}
              />
            </button>
            <button
              type="button"
              class={`term-icon-btn${searchOpen.value ? ' active' : ''}`}
              title="搜索终端内容 (Ctrl+Shift+F)"
              aria-label="搜索"
              onClick={() => {
                searchOpen.value = !searchOpen.value;
              }}
            >
              <Icon name="search" size={15} />
            </button>
            <button
              type="button"
              class={`term-icon-btn${sidePanelOpen.value ? ' active' : ''}`}
              title="侧边面板（文件 / 转发 / 命令片段）"
              aria-label="侧边面板"
              onClick={() => {
                sidePanelOpen.value = !sidePanelOpen.value;
              }}
            >
              <Icon name="panelRight" size={15} />
            </button>
            <button
              type="button"
              class={`term-icon-btn${zenMode.value ? ' active' : ''}`}
              title={zenMode.value ? '退出专注全屏' : '专注全屏'}
              aria-label={zenMode.value ? '退出专注全屏' : '专注全屏'}
              onClick={() => {
                zenMode.value = !zenMode.value;
              }}
            >
              <Icon name={zenMode.value ? 'minimize' : 'maximize'} size={15} />
            </button>
            <button
              type="button"
              class={`term-icon-btn${prefsOpen.value ? ' active' : ''}`}
              title="终端外观与偏好设置"
              aria-label="终端设置"
              onClick={() => {
                newMenuOpen.value = false;
                prefsOpen.value = !prefsOpen.value;
              }}
            >
              <Icon name="gear" size={15} />
            </button>

            {prefsOpen.value && (
              <TerminalPrefsPopover
                prefs={prefs.value}
                keybarOpen={keybarOpen.value}
                onUpdate={(next) => {
                  prefs.value = next;
                }}
                onToggleKeybar={() => {
                  keybarOpen.value = !keybarOpen.value;
                }}
                onExportTranscript={exportCurrentTranscript}
                onClose={() => {
                  prefsOpen.value = false;
                }}
              />
            )}
          </div>
        </header>

        <div class="term-stage">
          <div ref={paneAreaRef} class="term-pane-area">
            {loading.value && !tabs.value.length ? (
              <div style="margin:auto;color:var(--t-muted)">正在启动终端会话…</div>
            ) : activeTab ? (
              <div class={`term-pane-grid ${activeTab.layout}`}>
                {activeTab.panes.map((pane, idx) => {
                  const isSplit = activeTab.panes.length > 1;
                  const isFocused = pane.session.id === activePane?.session.id;
                  const flexBasis = isSplit
                    ? idx === 0
                      ? `${activeTab.splitRatio * 100}%`
                      : `${(1 - activeTab.splitRatio) * 100}%`
                    : '100%';
                  return (
                    <>
                      {idx === 1 && (
                        <div
                          class={`term-splitter${splittingDrag.value ? ' dragging' : ''}`}
                          onPointerdown={(e) => startSplitterDrag(e, activeTab)}
                        />
                      )}
                      <div
                        key={pane.session.id}
                        class={`term-pane${isSplit ? ' split' : ''}${isFocused ? ' focused' : ''}`}
                        style={`flex:0 0 ${flexBasis}`}
                        onMousedown={() => {
                          if (activeTab.activePaneId !== pane.session.id) {
                            activeTab.activePaneId = pane.session.id;
                            touchTabs();
                          }
                        }}
                        onContextmenu={(e) => {
                          e.preventDefault();
                          activeTab.activePaneId = pane.session.id;
                          touchTabs();
                          const { left, top, right, bottom } = appViewport();
                          const x = Math.max(left + 8, Math.min(appPixels(e.clientX), right - 224));
                          const y = Math.max(top + 8, Math.min(appPixels(e.clientY), bottom - 310));
                          contextMenu.value = {
                            paneId: pane.session.id,
                            style: {
                              left: `${x}px`,
                              top: `${y}px`,
                              maxWidth: `${right - x - 8}px`,
                              maxHeight: `${bottom - y - 8}px`,
                            },
                          };
                        }}
                      >
                        {isSplit && (
                          <div class="term-pane-head">
                            <span class="term-pane-title">
                              {pane.title} · {pane.cwd}
                            </span>
                            <button
                              type="button"
                              class="term-icon-btn xs"
                              title="关闭此窗格"
                              onClick={(e) => {
                                e.stopPropagation();
                                closePane(pane.session.id);
                              }}
                            >
                              <Icon name="close" size={11} />
                            </button>
                          </div>
                        )}
                        <div
                          class="term-pane-host"
                          ref={(el) => bindPaneHost(pane, el as HTMLDivElement | null)}
                        />
                      </div>
                    </>
                  );
                })}
              </div>
            ) : (
              <div class="term-disabled-card">
                <p class="term-side-hint">当前没有打开的终端标签页。</p>
                <button type="button" class="term-action-btn primary" onClick={() => void createNewTab()}>
                  <Icon name="plus" size={14} /> 新建终端
                </button>
              </div>
            )}

            {searchOpen.value && (
              <div class="term-search-float" onClick={(e) => e.stopPropagation()}>
                <input
                  type="search"
                  placeholder="搜索终端输出…"
                  value={searchQuery.value}
                  onInput={(e) => {
                    searchQuery.value = (e.currentTarget as HTMLInputElement).value;
                    if (searchQuery.value) activePane?.search.findNext(searchQuery.value);
                  }}
                  onKeydown={(e) => {
                    if (e.key === 'Enter' && searchQuery.value) {
                      if (e.shiftKey) activePane?.search.findPrevious(searchQuery.value);
                      else activePane?.search.findNext(searchQuery.value);
                    } else if (e.key === 'Escape') {
                      searchOpen.value = false;
                    }
                  }}
                />
                <button
                  type="button"
                  class="term-icon-btn sm"
                  title="上一个"
                  onClick={() => searchQuery.value && activePane?.search.findPrevious(searchQuery.value)}
                >
                  <Icon name="up" size={13} />
                </button>
                <button
                  type="button"
                  class="term-icon-btn sm"
                  title="下一个"
                  onClick={() => searchQuery.value && activePane?.search.findNext(searchQuery.value)}
                >
                  <Icon name="down" size={13} />
                </button>
                <button
                  type="button"
                  class="term-icon-btn sm"
                  title="关闭搜索"
                  onClick={() => {
                    searchOpen.value = false;
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            )}

            {draggingFile.value && (
              <div class="term-drop-overlay">松开以上传图片或文件到当前目录</div>
            )}
          </div>

          {sidePanelOpen.value && (
            <TerminalSidePanel
              tab={sidePanelTab.value}
              session={activePane?.session ?? null}
              sessionCwd={activePane?.cwd ?? ''}
              settings={settings.value}
              capabilities={capabilities.value}
              images={images.value}
              onTabChange={(next) => {
                sidePanelTab.value = next;
              }}
              onClose={() => {
                sidePanelOpen.value = false;
              }}
              onNotify={notify}
              onInsertText={(text) => {
                if (!activePane) return;
                sendRawInput(activePane.session.id, encoder.encode(text));
                activePane.term.focus();
              }}
              onRunCommand={(cmd, execute) => {
                if (!activePane) return;
                sendRawInput(activePane.session.id, encoder.encode(execute ? `${cmd}\r` : cmd));
                activePane.term.focus();
              }}
              onUploadToDirectory={(dir) => {
                pendingTransferFileResolve = null;
                uploadTargetDir = dir;
                filePickerRef.value?.click();
              }}
              onPreviewImage={(img) => {
                lightboxImage.value = img;
              }}
              onClearImages={() => {
                images.value = [];
              }}
              onUpdateHostSettings={updateHostSettings}
            />
          )}
        </div>

        {transfer.value && (
          <div class="term-transfer-hud">
            <span>
              {transfer.value.protocol.toUpperCase()} {transfer.value.direction === 'upload' ? '上传' : '下载'}：
              {transfer.value.fileName || '传输中'}
            </span>
            <div class="term-transfer-bar">
              <i
                style={`width: ${
                  transfer.value.total > 0
                    ? Math.min(100, Math.round((transfer.value.transferred / transfer.value.total) * 100))
                    : 100
                }%`}
              />
            </div>
            <span>
              {formatTransferBytes(transfer.value.transferred)}
              {transfer.value.total > 0 ? ` / ${formatTransferBytes(transfer.value.total)}` : ''}
            </span>
            <button
              type="button"
              class="term-action-btn"
              onClick={() => {
                activePane?.zmodem.cancel();
                activePane?.trzsz.cancel();
                transfer.value = null;
              }}
            >
              取消
            </button>
          </div>
        )}

        {keybarOpen.value && activePane && (
          <div class="term-keybar" aria-label="快捷按键栏">
            <button type="button" onClick={() => sendRawInput(activePane.session.id, new Uint8Array([0x1b]))}>
              Esc
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, new Uint8Array([0x09]))}>
              Tab
            </button>
            <button
              type="button"
              class={ctrlArmed.value ? 'armed' : undefined}
              onClick={() => {
                ctrlArmed.value = !ctrlArmed.value;
                activePane.term.focus();
              }}
            >
              Ctrl
            </button>
            <button
              type="button"
              class={altArmed.value ? 'armed' : undefined}
              onClick={() => {
                altArmed.value = !altArmed.value;
                activePane.term.focus();
              }}
            >
              Alt
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, new Uint8Array([0x03]))}>
              ^C
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, new Uint8Array([0x04]))}>
              ^D
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, new Uint8Array([0x1a]))}>
              ^Z
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, new Uint8Array([0x0c]))}>
              清屏
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, encoder.encode('\x1b[A'))}>
              ↑
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, encoder.encode('\x1b[B'))}>
              ↓
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, encoder.encode('\x1b[D'))}>
              ←
            </button>
            <button type="button" onClick={() => sendRawInput(activePane.session.id, encoder.encode('\x1b[C'))}>
              →
            </button>
          </div>
        )}

        <footer class="term-statusbar">
          <div class="term-status-left">
            <span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">
              <i class={`term-tab-dot${activePane?.session.running ? '' : ' exited'}`} aria-hidden="true" />
              {deviceSession.host?.name ?? '宿主机'} ·{' '}
              {activePane?.session.platform === 'windows' ? 'Windows ConPTY' : 'POSIX PTY'}
            </span>
            {activePane && (
              <button
                type="button"
                class="term-status-btn"
                title="点击在右侧文件面板打开当前目录"
                onClick={() => {
                  sidePanelTab.value = 'files';
                  sidePanelOpen.value = true;
                }}
              >
                <Icon name="folder" size={12} />
                {activePane.cwd}
              </button>
            )}
          </div>
          <div class="term-status-right">
            {activePane?.session.x11Display && (
              <button
                type="button"
                class="term-status-btn active"
                onClick={() => {
                  sidePanelTab.value = 'forwards';
                  sidePanelOpen.value = true;
                }}
              >
                X11 {activePane.session.x11Display}
              </button>
            )}
            {activePane?.session.waylandDisplay && (
              <button
                type="button"
                class="term-status-btn active"
                onClick={() => {
                  sidePanelTab.value = 'forwards';
                  sidePanelOpen.value = true;
                }}
              >
                Wayland
              </button>
            )}
            <button
              type="button"
              class="term-status-btn"
              title="查看文件管理与传输"
              onClick={() => {
                sidePanelTab.value = 'files';
                sidePanelOpen.value = !sidePanelOpen.value;
              }}
            >
              lrzsz · trzsz
            </button>
            <button
              type="button"
              class={`term-status-btn${keybarOpen.value ? ' active' : ''}`}
              onClick={() => {
                keybarOpen.value = !keybarOpen.value;
              }}
            >
              快捷键
            </button>
          </div>
        </footer>

        {contextMenu.value && ctxPane && (
          <div
            class="term-context-menu"
            style={contextMenu.value.style}
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="term-menu-item"
              disabled={!ctxPane.term.hasSelection()}
              onClick={() => {
                const text = ctxPane.term.getSelection();
                contextMenu.value = null;
                if (text) {
                  void navigator.clipboard?.writeText(text).then(() => notify('已复制选中内容'));
                }
              }}
            >
              <span>复制</span>
              <kbd>Ctrl+Shift+C</kbd>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                contextMenu.value = null;
                void navigator.clipboard?.readText().then((text) => {
                  if (text) sendRawInput(ctxPane.session.id, encoder.encode(text));
                });
              }}
            >
              <span>粘贴</span>
              <kbd>Ctrl+Shift+V</kbd>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                ctxPane.term.selectAll();
                contextMenu.value = null;
              }}
            >
              <span>全选</span>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                ctxPane.term.clear();
                contextMenu.value = null;
              }}
            >
              <span>清屏</span>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                searchOpen.value = true;
                contextMenu.value = null;
              }}
            >
              <span>搜索</span>
              <kbd>Ctrl+Shift+F</kbd>
            </button>
            <div class="term-menu-sep" />
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                contextMenu.value = null;
                void splitCurrentTab('horizontal');
              }}
            >
              <span>向右分屏</span>
              <kbd>Ctrl+Shift+D</kbd>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                contextMenu.value = null;
                void splitCurrentTab('vertical');
              }}
            >
              <span>向下分屏</span>
              <kbd>Ctrl+Shift+E</kbd>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                contextMenu.value = null;
                pendingTransferFileResolve = null;
                uploadTargetDir = ctxPane.cwd;
                filePickerRef.value?.click();
              }}
            >
              <span>上传文件 / 图片…</span>
            </button>
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                contextMenu.value = null;
                exportCurrentTranscript();
              }}
            >
              <span>导出终端记录 (.txt)</span>
            </button>
            <div class="term-menu-sep" />
            <button
              type="button"
              class="term-menu-item"
              onClick={() => {
                const id = ctxPane.session.id;
                contextMenu.value = null;
                void restartPane(id);
              }}
            >
              <span>重启当前会话</span>
            </button>
          </div>
        )}

        {lightboxImage.value && (
          <div
            class="term-lightbox"
            onClick={() => {
              lightboxImage.value = null;
            }}
          >
            <div class="term-lightbox-inner" onClick={(e) => e.stopPropagation()}>
              <img src={lightboxImage.value.dataUrl} alt={lightboxImage.value.name || '终端图片'} />
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <span class="term-side-meta">
                  {lightboxImage.value.name || lightboxImage.value.protocol.toUpperCase()}
                </span>
                <div style="display:flex;gap:8px">
                  <a
                    class="term-action-btn primary"
                    href={lightboxImage.value.dataUrl}
                    download={lightboxImage.value.name || 'terminal-image.png'}
                  >
                    保存图片
                  </a>
                  <button
                    type="button"
                    class="term-action-btn"
                    onClick={() => {
                      lightboxImage.value = null;
                    }}
                  >
                    关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {toast.value && <div class="term-toast">{toast.value}</div>}
      </main>
    );
  };
});
