import { onScopeDispose, shallowRef } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { tsxComponent } from '../tsx-component';
import { watchRender } from '../render-effects';
import { deviceSession } from '../device-session';
import type { AppRoute } from '../shell/routes';
import { Icon } from '../Icon';
import {
  TERMINAL_BACKEND_ID,
  type TerminalHostCapabilities,
  type TerminalPluginSettings,
  type TerminalSessionSummary,
  type TerminalShellOption,
} from '../../shared/plugins';
import { ZmodemFilter, type TerminalTransferProgress } from './zmodem';
import { TrzszFilter } from './trzsz';
import { TerminalSequenceFilter, type TerminalCapturedImage } from './kitty-graphics';
import { formatTransferBytes } from './shell-escape';
import { TerminalForwardDrawer } from './TerminalForwardDrawer';
import './terminal.css';

interface ActiveTerminalTab {
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
}

const encoder = new TextEncoder();

export default tsxComponent(function TerminalWorkspace(_props: {
  active: boolean;
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
}) {
  const hostMount = shallowRef<HTMLDivElement | null>(null);
  const tabs = shallowRef<ActiveTerminalTab[]>([]);
  const activeTabId = shallowRef<string>('');
  const shells = shallowRef<TerminalShellOption[]>([]);
  const selectedShell = shallowRef<string>('');
  const settings = shallowRef<TerminalPluginSettings | null>(null);
  const capabilities = shallowRef<TerminalHostCapabilities | null>(null);
  const disabledMessage = shallowRef<string>('');
  const loading = shallowRef(true);
  const fontSize = shallowRef(14);
  const searchOpen = shallowRef(false);
  const searchQuery = shallowRef('');
  const forwardDrawerOpen = shallowRef(false);
  const keybarOpen = shallowRef(typeof window !== 'undefined' && window.innerWidth < 820);
  const ctrlArmed = shallowRef(false);
  const altArmed = shallowRef(false);
  const draggingFile = shallowRef(false);
  const transfer = shallowRef<TerminalTransferProgress | null>(null);
  const images = shallowRef<TerminalCapturedImage[]>([]);
  const lightboxImage = shallowRef<TerminalCapturedImage | null>(null);
  const toast = shallowRef<string>('');
  const newTabX11 = shallowRef(false);
  const newTabWayland = shallowRef(false);

  const filePickerRef = shallowRef<HTMLInputElement | null>(null);
  let pendingTransferFileResolve: ((files: File[]) => void) | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const watchInit = watchRender();
  const watchActiveMount = watchRender();
  const watchFontSize = watchRender();

  function notify(message: string) {
    toast.value = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast.value === message) toast.value = '';
    }, 3200);
  }

  function currentTab(): ActiveTerminalTab | undefined {
    return tabs.value.find((tab) => tab.session.id === activeTabId.value) ?? tabs.value[0];
  }

  function sendRawInput(sessionId: string, bytes: Uint8Array) {
    if (!bytes.length) return;
    void deviceSession.terminalRequest('terminal-input', { sessionId }, bytes).catch(() => {});
  }

  function triggerDownload(name: string, data: Uint8Array) {
    const blob = new Blob([data as Uint8Array<ArrayBuffer>]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'download.bin';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify(`已保存文件 ${name}（${formatTransferBytes(data.byteLength)}）`);
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
      input.value = '';
      input.click();
    });
  }

  function buildTab(session: TerminalSessionSummary): ActiveTerminalTab {
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize.value,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: '#0d1317',
        foreground: '#e6edf3',
        cursor: '#87d1b5',
        selectionBackground: 'rgba(135, 209, 181, 0.32)',
      },
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

    const sendBytes = (bytes: Uint8Array) => sendRawInput(session.id, bytes);
    const zmodem = new ZmodemFilter({
      sendBytes,
      onProgress: (p) => {
        transfer.value = p;
      },
      onDownloadFile: triggerDownload,
      onRequestUploadFiles: requestUploadFiles,
    });
    const trzsz = new TrzszFilter({
      sendBytes,
      onProgress: (p) => {
        transfer.value = p;
      },
      onDownloadFile: triggerDownload,
      onRequestUploadFiles: requestUploadFiles,
    });
    const sequences = new TerminalSequenceFilter({
      sendReply: sendBytes,
      onImage: (img) => {
        images.value = [...images.value.slice(-19), img];
      },
      onClipboardWrite: (text) => {
        if (settings.value?.allowOsc52Clipboard === false) return;
        void navigator.clipboard?.writeText(text).then(
          () => notify('已通过 OSC 52 同步到剪贴板'),
          () => {},
        );
      },
      onCwdChange: (cwd) => {
        tab.cwd = cwd;
        tabs.value = [...tabs.value];
      },
    });

    const tab: ActiveTerminalTab = {
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
    };

    term.onTitleChange((title) => {
      if (title.trim()) {
        tab.title = title.trim();
        tabs.value = [...tabs.value];
      }
    });

    term.onData((text) => {
      let payload = text;
      if (ctrlArmed.value && text.length === 1) {
        const code = text.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) payload = String.fromCharCode(code - 64);
        ctrlArmed.value = false;
      } else if (altArmed.value) {
        payload = `\x1b${text}`;
        altArmed.value = false;
      }
      sendRawInput(session.id, encoder.encode(payload));
    });

    term.onBinary((bin) => {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      sendRawInput(session.id, bytes);
    });

    term.onResize(({ cols, rows }) => {
      void deviceSession
        .terminalRequest('terminal-resize', { sessionId: session.id, cols, rows })
        .catch(() => {});
    });

    return tab;
  }

  function feedOutput(tab: ActiveTerminalTab, chunk: Uint8Array) {
    if (!chunk.length) return;
    const afterZ = tab.zmodem.process(chunk);
    if (!afterZ.length) return;
    const afterT = tab.trzsz.process(afterZ);
    if (!afterT.length) return;
    const afterSeq = tab.sequences.process(afterT);
    if (afterSeq.length) tab.term.write(afterSeq);
  }

  async function attachTab(session: TerminalSessionSummary) {
    const existing = tabs.value.find((t) => t.session.id === session.id);
    const tab = existing ?? buildTab(session);
    if (!existing) {
      tabs.value = [...tabs.value, tab];
    }
    activeTabId.value = session.id;
    const { bytes } = await deviceSession.terminalRequest('terminal-attach', {
      sessionId: session.id,
    });
    if (bytes && bytes.length) {
      feedOutput(tab, bytes);
    }
  }

  async function createNewTab() {
    try {
      const active = currentTab();
      const cols = active?.term.cols || 100;
      const rows = active?.term.rows || 30;
      const res = (await deviceSession.api(
        '/api/terminal/sessions',
        {
          method: 'POST',
          body: JSON.stringify({
            shell: selectedShell.value || undefined,
            cols,
            rows,
            enableX11: newTabX11.value,
            enableWayland: newTabWayland.value,
          }),
        },
        TERMINAL_BACKEND_ID,
      )) as { session: TerminalSessionSummary };
      await attachTab(res.session);
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法新建终端会话');
    }
  }

  async function closeTab(sessionId: string) {
    const idx = tabs.value.findIndex((t) => t.session.id === sessionId);
    if (idx < 0) return;
    const tab = tabs.value[idx];
    tab.zmodem.cancel();
    tab.trzsz.cancel();
    tab.term.dispose();
    tabs.value = tabs.value.filter((t) => t.session.id !== sessionId);
    if (activeTabId.value === sessionId) {
      activeTabId.value = tabs.value[Math.max(0, idx - 1)]?.session.id ?? '';
    }
    void deviceSession
      .api(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: '{}' }, TERMINAL_BACKEND_ID)
      .catch(() => {});
  }

  async function uploadFilesToSession(files: File[]) {
    const tab = currentTab();
    if (!tab || !files.length) return;
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
          `/api/terminal/sessions/${encodeURIComponent(tab.session.id)}/upload`,
          'POST',
          { name: file.name, directory: tab.cwd || undefined },
          bytes,
          TERMINAL_BACKEND_ID,
          60000,
        );
        sendRawInput(tab.session.id, encoder.encode(`${value.shellPath} `));
        notify(`已上传到 ${value.path} 并插入路径`);
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

  function disposeAllTabs() {
    for (const tab of tabs.value) {
      tab.term.dispose();
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
        const tab = tabs.value.find((t) => t.session.id === event.sessionId);
        if (!tab) return;
        if (event.type === 'terminal-output' && bytes) {
          feedOutput(tab, bytes);
        } else if (event.type === 'terminal-exit') {
          tab.session = { ...tab.session, running: false, exitCode: event.exitCode ?? null };
          tab.term.writeln(`\r\n\x1b[90m[进程已退出，退出码: ${event.exitCode ?? '未知'}]\x1b[0m`);
          tabs.value = [...tabs.value];
        }
      });

      const onKeydown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          searchOpen.value = !searchOpen.value;
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
          const existing: TerminalSessionSummary[] = (res.sessions ?? []).filter(
            (s: TerminalSessionSummary) => s.running,
          );
          if (existing.length) {
            for (const session of existing) {
              await attachTab(session);
            }
          } else {
            await createNewTab();
          }
        })
        .catch((error) => {
          if (!alive) return;
          disabledMessage.value =
            error instanceof Error ? error.message : '终端插件未启用或电脑暂未连接';
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
    watchActiveMount(() => {
      const mount = hostMount.value;
      if (!mount || !activeTab) return;
      mount.replaceChildren(activeTab.container);
      if (!activeTab.term.element) {
        activeTab.term.open(activeTab.container);
      }
      const fitNow = () => {
        try {
          activeTab.fit.fit();
        } catch {
          /* Ignore resize while hidden. */
        }
      };
      fitNow();
      activeTab.term.focus();
      const observer = new ResizeObserver(() => fitNow());
      observer.observe(mount);
      return () => observer.disconnect();
    }, [hostMount.value, activeTab?.session.id, active, forwardDrawerOpen.value, keybarOpen.value]);

    watchFontSize(() => {
      for (const tab of tabs.value) {
        tab.term.options.fontSize = fontSize.value;
        try {
          tab.fit.fit();
        } catch {}
      }
    }, [fontSize.value]);

    if (disabledMessage.value) {
      return (
        <main class="terminal-workspace">
          <div class="terminal-disabled-card">
            <Icon name="terminal" size={32} />
            <h2 style="margin: 0; font-size: 18px">终端插件当前不可用</h2>
            <p style="margin: 0; color: #9bb0be; font-size: 13px">{disabledMessage.value}</p>
            <div style="display: flex; justify-content: center; gap: 10px">
              <button type="button" class="terminal-btn" onClick={() => navigate({ page: 'plugins' })}>
                前往插件管理开启
              </button>
              <button type="button" class="terminal-btn" onClick={() => navigate({ page: 'workbench' })}>
                返回工作台
              </button>
            </div>
          </div>
        </main>
      );
    }

    return (
      <main
        class="terminal-workspace"
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
              void uploadFilesToSession(picked);
            }
          }}
        />

        <header class="terminal-topbar">
          <button
            type="button"
            class="terminal-btn"
            aria-label="返回工作台"
            onClick={() => navigate({ page: 'workbench' })}
          >
            <Icon name="back" size={15} />
          </button>

          <div class="terminal-tabs" role="tablist" aria-label="终端标签页">
            {tabs.value.map((tab) => (
              <div
                key={tab.session.id}
                role="tab"
                aria-selected={tab.session.id === activeTab?.session.id}
                class={`terminal-tab${tab.session.id === activeTab?.session.id ? ' active' : ''}`}
                onClick={() => {
                  activeTabId.value = tab.session.id;
                }}
              >
                <Icon name="terminal" size={13} />
                <span class="terminal-tab-title">{tab.title}</span>
                <button
                  type="button"
                  class="terminal-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.session.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div class="terminal-toolbar">
            {shells.value.length > 0 && (
              <select
                class="terminal-select"
                aria-label="新建终端 Shell"
                value={selectedShell.value}
                onChange={(e) => {
                  selectedShell.value = (e.currentTarget as HTMLSelectElement).value;
                }}
              >
                <option value="">默认 Shell</option>
                {shells.value.map((sh) => (
                  <option key={sh.path} value={sh.path}>
                    {sh.name}
                  </option>
                ))}
              </select>
            )}
            {settings.value?.allowX11Forwarding && (
              <button
                type="button"
                class={`terminal-btn${newTabX11.value ? ' active' : ''}`}
                title="新建标签页时注入 X11 转发"
                onClick={() => {
                  newTabX11.value = !newTabX11.value;
                }}
              >
                X11
              </button>
            )}
            {settings.value?.allowWaylandForwarding && activeTab?.session.platform !== 'windows' && (
              <button
                type="button"
                class={`terminal-btn${newTabWayland.value ? ' active' : ''}`}
                title="新建标签页时注入 Wayland 转发"
                onClick={() => {
                  newTabWayland.value = !newTabWayland.value;
                }}
              >
                Wayland
              </button>
            )}
            <button type="button" class="terminal-btn" onClick={() => void createNewTab()} title="新建终端">
              <Icon name="plus" size={14} /> 新建
            </button>
            <button
              type="button"
              class="terminal-btn"
              title="上传图片或文件到当前目录"
              onClick={() => {
                pendingTransferFileResolve = null;
                filePickerRef.value?.click();
              }}
            >
              <Icon name="image" size={14} /> 传图/文件
            </button>
            <button
              type="button"
              class={`terminal-btn${searchOpen.value ? ' active' : ''}`}
              title="搜索终端内容 (Ctrl+Shift+F)"
              onClick={() => {
                searchOpen.value = !searchOpen.value;
              }}
            >
              <Icon name="search" size={14} />
            </button>
            <button
              type="button"
              class={`terminal-btn${forwardDrawerOpen.value ? ' active' : ''}`}
              title="X11 / Wayland / 端口转发与文件下载"
              onClick={() => {
                forwardDrawerOpen.value = !forwardDrawerOpen.value;
              }}
            >
              <Icon name="globe" size={14} /> 转发
            </button>
            <button
              type="button"
              class="terminal-btn"
              title="缩小字体"
              onClick={() => {
                fontSize.value = Math.max(10, fontSize.value - 1);
              }}
            >
              A-
            </button>
            <button
              type="button"
              class="terminal-btn"
              title="放大字体"
              onClick={() => {
                fontSize.value = Math.min(26, fontSize.value + 1);
              }}
            >
              A+
            </button>
            <button
              type="button"
              class={`terminal-btn${keybarOpen.value ? ' active' : ''}`}
              title="切换快捷按键栏"
              onClick={() => {
                keybarOpen.value = !keybarOpen.value;
              }}
            >
              键盘
            </button>
          </div>
        </header>

        {activeTab && (
          <div class="terminal-meta-bar">
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {deviceSession.host?.name ?? '电脑'} · {activeTab.cwd}
            </span>
            <div class="terminal-meta-badges">
              <span class="terminal-meta-badge">
                {activeTab.session.platform === 'windows' ? 'Windows ConPTY' : 'POSIX PTY'}
              </span>
              <span class="terminal-meta-badge">lrzsz · trzsz · 图片</span>
              {activeTab.session.x11Display && (
                <span class="terminal-meta-badge">DISPLAY={activeTab.session.x11Display}</span>
              )}
              {activeTab.session.waylandDisplay && (
                <span class="terminal-meta-badge">WAYLAND={activeTab.session.waylandDisplay}</span>
              )}
            </div>
          </div>
        )}

        {searchOpen.value && (
          <div class="terminal-search-bar">
            <input
              type="search"
              placeholder="搜索终端输出…"
              value={searchQuery.value}
              onInput={(e) => {
                searchQuery.value = (e.currentTarget as HTMLInputElement).value;
                if (searchQuery.value) activeTab?.search.findNext(searchQuery.value);
              }}
              onKeydown={(e) => {
                if (e.key === 'Enter' && searchQuery.value) {
                  if (e.shiftKey) activeTab?.search.findPrevious(searchQuery.value);
                  else activeTab?.search.findNext(searchQuery.value);
                } else if (e.key === 'Escape') {
                  searchOpen.value = false;
                }
              }}
            />
            <button
              type="button"
              class="terminal-btn"
              onClick={() => searchQuery.value && activeTab?.search.findPrevious(searchQuery.value)}
            >
              上一个
            </button>
            <button
              type="button"
              class="terminal-btn"
              onClick={() => searchQuery.value && activeTab?.search.findNext(searchQuery.value)}
            >
              下一个
            </button>
            <button
              type="button"
              class="terminal-btn"
              onClick={() => {
                searchOpen.value = false;
              }}
            >
              关闭
            </button>
          </div>
        )}

        <div class="terminal-stage">
          {loading.value && !tabs.value.length ? (
            <div class="page-loading" style="margin: auto; color: #9bb0be">
              正在启动终端会话…
            </div>
          ) : (
            <div ref={hostMount} class="terminal-canvas-host" />
          )}

          {draggingFile.value && (
            <div class="terminal-drop-overlay">松开以上传图片或文件到当前终端目录</div>
          )}

          {forwardDrawerOpen.value && (
            <TerminalForwardDrawer
              session={activeTab?.session ?? null}
              settings={settings.value}
              capabilities={capabilities.value}
              onClose={() => {
                forwardDrawerOpen.value = false;
              }}
              onNotify={notify}
            />
          )}
        </div>

        {transfer.value && (
          <div class="terminal-transfer-hud" role="status">
            <strong>
              {transfer.value.protocol.toUpperCase()}{' '}
              {transfer.value.direction === 'upload' ? '上传' : '下载'}
            </strong>
            <span>{transfer.value.message || transfer.value.fileName}</span>
            <div class="terminal-transfer-bar">
              <i
                style={`width: ${
                  transfer.value.total > 0
                    ? Math.min(100, Math.round((transfer.value.transferred / transfer.value.total) * 100))
                    : transfer.value.status === 'done'
                      ? 100
                      : 30
                }%`}
              />
            </div>
            {transfer.value.total > 0 && (
              <span>
                {formatTransferBytes(transfer.value.transferred)} / {formatTransferBytes(transfer.value.total)}
              </span>
            )}
            {transfer.value.status === 'active' && (
              <button
                type="button"
                class="terminal-btn"
                onClick={() => {
                  activeTab?.zmodem.cancel();
                  activeTab?.trzsz.cancel();
                }}
              >
                取消
              </button>
            )}
          </div>
        )}

        {images.value.length > 0 && (
          <div class="terminal-image-strip" aria-label="终端图片记录">
            <small style="color: #8ea5b4; flex: none">图片 ({images.value.length})</small>
            {images.value.map((img) => (
              <button
                type="button"
                key={img.id}
                class="terminal-image-thumb"
                title={img.name || img.protocol}
                onClick={() => {
                  lightboxImage.value = img;
                }}
              >
                <img src={img.dataUrl} alt={img.name || '终端图片'} />
              </button>
            ))}
            <button
              type="button"
              class="terminal-btn"
              style="margin-left: auto"
              onClick={() => {
                images.value = [];
              }}
            >
              清空
            </button>
          </div>
        )}

        {keybarOpen.value && activeTab && (
          <div class="terminal-keybar" role="toolbar" aria-label="终端快捷按键">
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b'))}>
              Esc
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\t'))}>
              Tab
            </button>
            <button
              type="button"
              class={ctrlArmed.value ? 'armed' : undefined}
              onClick={() => {
                ctrlArmed.value = !ctrlArmed.value;
              }}
            >
              Ctrl
            </button>
            <button
              type="button"
              class={altArmed.value ? 'armed' : undefined}
              onClick={() => {
                altArmed.value = !altArmed.value;
              }}
            >
              Alt
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x03'))}>
              Ctrl+C
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x04'))}>
              Ctrl+D
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1a'))}>
              Ctrl+Z
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b[A'))}>
              ↑
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b[B'))}>
              ↓
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b[D'))}>
              ←
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b[C'))}>
              →
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b[H'))}>
              Home
            </button>
            <button type="button" onClick={() => sendRawInput(activeTab.session.id, encoder.encode('\x1b[F'))}>
              End
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.readText().then((text) => {
                  if (text) sendRawInput(activeTab.session.id, encoder.encode(text));
                });
              }}
            >
              粘贴
            </button>
          </div>
        )}

        {toast.value && (
          <div class="terminal-toast" role="status">
            {toast.value}
          </div>
        )}

        {lightboxImage.value && (
          <div
            class="terminal-lightbox"
            onClick={() => {
              lightboxImage.value = null;
            }}
          >
            <div class="terminal-lightbox-inner" onClick={(e) => e.stopPropagation()}>
              <img src={lightboxImage.value.dataUrl} alt={lightboxImage.value.name || '终端图片预览'} />
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px">
                <small style="color: #c2d1db">
                  {lightboxImage.value.name || `协议: ${lightboxImage.value.protocol}`}
                </small>
                <div style="display: flex; gap: 8px">
                  <a
                    class="terminal-btn"
                    href={lightboxImage.value.dataUrl}
                    download={lightboxImage.value.name || `terminal-${lightboxImage.value.id}.png`}
                  >
                    保存图片
                  </a>
                  <button
                    type="button"
                    class="terminal-btn"
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
      </main>
    );
  };
});
