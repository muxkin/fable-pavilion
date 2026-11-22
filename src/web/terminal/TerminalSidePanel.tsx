import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender } from '../render-effects';
import { deviceSession } from '../device-session';
import { Icon } from '../Icon';
import {
  TERMINAL_BACKEND_ID,
  type TerminalForwardSummary,
  type TerminalFsEntry,
  type TerminalFsListing,
  type TerminalHostCapabilities,
  type TerminalPluginSettings,
  type TerminalSessionSummary,
} from '../../shared/plugins';
import type { TerminalCapturedImage } from './kitty-graphics';
import { formatTransferBytes } from './shell-escape';
import {
  BUILTIN_SNIPPETS,
  loadUserSnippets,
  saveUserSnippets,
  type TerminalSnippet,
} from './terminal-prefs';

export type SidePanelTab = 'files' | 'forwards' | 'snippets';

export const TerminalSidePanel = tsxComponent(function TerminalSidePanel(_props: {
  tab: SidePanelTab;
  session: TerminalSessionSummary | null;
  sessionCwd: string;
  settings: TerminalPluginSettings | null;
  capabilities: TerminalHostCapabilities | null;
  images: TerminalCapturedImage[];
  onTabChange: (tab: SidePanelTab) => void;
  onClose: () => void;
  onNotify: (msg: string) => void;
  onInsertText: (text: string) => void;
  onRunCommand: (command: string, execute: boolean) => void;
  onUploadToDirectory: (dir: string) => void;
  onPreviewImage: (img: TerminalCapturedImage) => void;
  onClearImages: () => void;
  onUpdateHostSettings: (patch: Partial<TerminalPluginSettings>) => Promise<void>;
}) {
  // Files tab state
  const currentPath = shallowRef('');
  const listing = shallowRef<TerminalFsListing | null>(null);
  const filesLoading = shallowRef(false);
  const showHidden = shallowRef(false);
  const newFolderOpen = shallowRef(false);
  const newFolderName = shallowRef('');
  const fsError = shallowRef('');

  // Forwards tab state
  const forwards = shallowRef<TerminalForwardSummary[]>([]);
  const targetHost = shallowRef('127.0.0.1');
  const targetPort = shallowRef('8080');
  const httpPath = shallowRef('/');
  const httpPreview = shallowRef('');

  // Snippets tab state
  const userSnippets = shallowRef<TerminalSnippet[]>(loadUserSnippets());
  const addSnippetOpen = shallowRef(false);
  const snipTitle = shallowRef('');
  const snipCommand = shallowRef('');
  const snipRun = shallowRef(true);

  const busy = shallowRef(false);
  const watchFiles = watchRender();
  const watchForwards = watchRender();

  async function refreshFiles(sessionId: string, path?: string) {
    filesLoading.value = true;
    fsError.value = '';
    try {
      const res = (await deviceSession.api(
        `/api/terminal/sessions/${encodeURIComponent(sessionId)}/fs/list`,
        {
          method: 'POST',
          body: JSON.stringify({ path: path || undefined, showHidden: showHidden.value }),
        },
        TERMINAL_BACKEND_ID,
      )) as TerminalFsListing;
      listing.value = res;
      currentPath.value = res.cwd;
    } catch (error) {
      fsError.value = error instanceof Error ? error.message : '无法读取目录';
    } finally {
      filesLoading.value = false;
    }
  }

  async function refreshForwards() {
    try {
      const res = (await deviceSession.api('/api/terminal/forwards', { method: 'GET' }, TERMINAL_BACKEND_ID)) as {
        forwards?: TerminalForwardSummary[];
      };
      forwards.value = res.forwards ?? [];
    } catch {
      forwards.value = [];
    }
  }

  return ({
    tab,
    session,
    sessionCwd,
    settings,
    capabilities,
    images,
    onTabChange,
    onClose,
    onNotify,
    onInsertText,
    onRunCommand,
    onUploadToDirectory,
    onPreviewImage,
    onClearImages,
    onUpdateHostSettings,
  }) => {
    watchFiles(() => {
      if (tab === 'files' && session) {
        const target = currentPath.value || sessionCwd || session.cwd;
        void refreshFiles(session.id, target);
      }
    }, [tab, session?.id, sessionCwd, showHidden.value]);

    watchForwards(() => {
      if (tab === 'forwards' && session) {
        void refreshForwards();
      }
    }, [tab, session?.id]);

    async function downloadEntry(entry: TerminalFsEntry) {
      if (!session || busy.value) return;
      busy.value = true;
      try {
        const { value, bytes } = await deviceSession.rpcBinary<{ name: string; size: number }>(
          `/api/terminal/sessions/${encodeURIComponent(session.id)}/download`,
          'POST',
          { path: entry.path },
          undefined,
          TERMINAL_BACKEND_ID,
        );
        if (!bytes) throw new Error('未读取到文件内容');
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = value.name || entry.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        onNotify(`已下载 ${value.name}（${formatTransferBytes(value.size)}）`);
      } catch (error) {
        onNotify(error instanceof Error ? error.message : '下载失败');
      } finally {
        busy.value = false;
      }
    }

    const allSnippets = [...userSnippets.value, ...BUILTIN_SNIPPETS];

    return (
      <aside class="term-sidepanel" aria-label="终端侧边面板">
        <header class="term-side-head">
          <div class="term-side-tabs" role="tablist">
            {(
              [
                ['files', '文件'],
                ['forwards', '转发'],
                ['snippets', '片段'],
              ] as [SidePanelTab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                class={tab === id ? 'active' : undefined}
                onClick={() => onTabChange(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" class="term-icon-btn sm" aria-label="收起侧栏" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div class="term-side-body">
          {tab === 'files' && (
            <>
              <div class="term-fs-bar">
                <span class="term-fs-path" title={listing.value?.cwd || sessionCwd}>
                  {listing.value?.cwd || sessionCwd || '~'}
                </span>
                <div class="term-fs-tools">
                  {listing.value?.parent && session && (
                    <button
                      type="button"
                      class="term-icon-btn sm"
                      title="上级目录"
                      onClick={() => void refreshFiles(session.id, listing.value!.parent!)}
                    >
                      <Icon name="up" size={14} />
                    </button>
                  )}
                  {session && (
                    <>
                      <button
                        type="button"
                        class="term-icon-btn sm"
                        title="上传文件/图片到此目录"
                        onClick={() => onUploadToDirectory(listing.value?.cwd || sessionCwd || session.cwd)}
                      >
                        <Icon name="upload" size={14} />
                      </button>
                      <button
                        type="button"
                        class="term-icon-btn sm"
                        title="新建文件夹"
                        onClick={() => {
                          newFolderOpen.value = !newFolderOpen.value;
                        }}
                      >
                        <Icon name="folderPlus" size={14} />
                      </button>
                      <button
                        type="button"
                        class={`term-icon-btn sm${showHidden.value ? ' active' : ''}`}
                        title={showHidden.value ? '隐藏点文件' : '显示隐藏文件'}
                        onClick={() => {
                          showHidden.value = !showHidden.value;
                        }}
                      >
                        .
                      </button>
                      <button
                        type="button"
                        class="term-icon-btn sm"
                        title="刷新目录"
                        onClick={() => void refreshFiles(session.id, currentPath.value || sessionCwd)}
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {newFolderOpen.value && session && (
                <form
                  class="term-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = newFolderName.value.trim();
                    if (!name) return;
                    busy.value = true;
                    void deviceSession
                      .api(
                        `/api/terminal/sessions/${encodeURIComponent(session.id)}/fs/mkdir`,
                        {
                          method: 'POST',
                          body: JSON.stringify({ path: listing.value?.cwd || sessionCwd, name }),
                        },
                        TERMINAL_BACKEND_ID,
                      )
                      .then(() => {
                        newFolderName.value = '';
                        newFolderOpen.value = false;
                        return refreshFiles(session.id, listing.value?.cwd || sessionCwd);
                      })
                      .catch((err) => onNotify(err instanceof Error ? err.message : '创建目录失败'))
                      .finally(() => {
                        busy.value = false;
                      });
                  }}
                >
                  <input
                    type="text"
                    placeholder="新文件夹名称"
                    value={newFolderName.value}
                    onInput={(e) => {
                      newFolderName.value = (e.currentTarget as HTMLInputElement).value;
                    }}
                  />
                  <button type="submit" class="term-action-btn primary" disabled={busy.value}>
                    创建
                  </button>
                </form>
              )}

              {fsError.value && <p class="term-side-hint error">{fsError.value}</p>}
              {filesLoading.value && !listing.value && <p class="term-side-hint">正在读取目录…</p>}

              <div class="term-fs-list">
                {listing.value?.entries.map((entry) => {
                  const isDir = entry.kind === 'dir';
                  const isImg = !isDir && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(entry.name);
                  return (
                    <div
                      key={entry.path}
                      class="term-fs-row"
                      onDblclick={() => {
                        if (isDir && session) void refreshFiles(session.id, entry.path);
                        else if (!isDir) void downloadEntry(entry);
                      }}
                    >
                      <button
                        type="button"
                        class="term-fs-main"
                        title={entry.path}
                        onClick={() => {
                          if (isDir && session) void refreshFiles(session.id, entry.path);
                        }}
                      >
                        <Icon name={isDir ? 'folder' : isImg ? 'image' : 'document'} size={15} />
                        <span class="term-fs-name">
                          {entry.name}
                          {isDir ? '/' : ''}
                        </span>
                      </button>
                      {!isDir && <small class="term-fs-size">{formatTransferBytes(entry.size)}</small>}
                      <div class="term-fs-row-actions">
                        {!isDir && (
                          <button
                            type="button"
                            class="term-icon-btn xs"
                            title="下载文件"
                            disabled={busy.value}
                            onClick={() => void downloadEntry(entry)}
                          >
                            <Icon name="download" size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          class="term-icon-btn xs"
                          title="插入路径到终端"
                          onClick={() => {
                            onInsertText(`${entry.shellPath} `);
                            onNotify(`已插入路径 ${entry.name}`);
                          }}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                        {session && (
                          <button
                            type="button"
                            class="term-icon-btn xs danger"
                            title="删除"
                            disabled={busy.value}
                            onClick={() => {
                              if (!window.confirm(`确定删除「${entry.name}」？`)) return;
                              busy.value = true;
                              void deviceSession
                                .api(
                                  `/api/terminal/sessions/${encodeURIComponent(session.id)}/fs/delete`,
                                  { method: 'POST', body: JSON.stringify({ path: entry.path }) },
                                  TERMINAL_BACKEND_ID,
                                )
                                .then(() => refreshFiles(session.id, listing.value?.cwd || sessionCwd))
                                .catch((err) => onNotify(err instanceof Error ? err.message : '删除失败'))
                                .finally(() => {
                                  busy.value = false;
                                });
                            }}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {listing.value && listing.value.entries.length === 0 && (
                  <p class="term-side-hint">此目录为空，可直接拖拽文件或图片到终端上传。</p>
                )}
              </div>

              {images.length > 0 && (
                <section class="term-side-card">
                  <div class="term-side-card-head">
                    <strong>会话图片 ({images.length})</strong>
                    <button type="button" class="term-link-btn" onClick={onClearImages}>
                      清空
                    </button>
                  </div>
                  <div class="term-side-images">
                    {images.map((img) => (
                      <button
                        type="button"
                        key={img.id}
                        class="term-side-thumb"
                        title={img.name || img.protocol}
                        onClick={() => onPreviewImage(img)}
                      >
                        <img src={img.dataUrl} alt={img.name || '终端图片'} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {tab === 'forwards' && (
            <>
              <section class="term-side-card">
                <strong>显示与端口权限</strong>
                <div class="term-prefs-toggles">
                  <label class="term-toggle-line">
                    <span>
                      X11 转发
                      {session?.x11Display ? ` (${session.x11Display})` : ''}
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(settings?.allowX11Forwarding)}
                      disabled={busy.value}
                      onChange={(e) => {
                        const checked = (e.currentTarget as HTMLInputElement).checked;
                        busy.value = true;
                        void onUpdateHostSettings({ allowX11Forwarding: checked }).finally(() => {
                          busy.value = false;
                        });
                      }}
                    />
                  </label>
                  {session?.platform !== 'windows' && (
                    <label class="term-toggle-line">
                      <span>
                        Wayland 转发
                        {session?.waylandDisplay ? ` (${session.waylandDisplay})` : ''}
                      </span>
                      <input
                        type="checkbox"
                        checked={Boolean(settings?.allowWaylandForwarding)}
                        disabled={busy.value}
                        onChange={(e) => {
                          const checked = (e.currentTarget as HTMLInputElement).checked;
                          busy.value = true;
                          void onUpdateHostSettings({ allowWaylandForwarding: checked }).finally(() => {
                            busy.value = false;
                          });
                        }}
                      />
                    </label>
                  )}
                  <label class="term-toggle-line">
                    <span>本机回环端口转发</span>
                    <input
                      type="checkbox"
                      checked={Boolean(settings?.allowPortForwarding)}
                      disabled={busy.value}
                      onChange={(e) => {
                        const checked = (e.currentTarget as HTMLInputElement).checked;
                        busy.value = true;
                        void onUpdateHostSettings({ allowPortForwarding: checked }).finally(() => {
                          busy.value = false;
                        });
                      }}
                    />
                  </label>
                </div>
                {capabilities && (
                  <small class="term-side-meta">
                    宿主机：{capabilities.ptyBackend}
                    {capabilities.x11HostDisplay ? ` · DISPLAY=${capabilities.x11HostDisplay}` : ''}
                    {capabilities.waylandHostDisplay ? ` · Wayland=${capabilities.waylandHostDisplay}` : ''}
                    {capabilities.hasXvfb ? ' · Xvfb' : ''}
                    {capabilities.hasXpra ? ' · Xpra' : ''}
                    {capabilities.hasWaypipe ? ' · Waypipe' : ''}
                    {capabilities.hasWsl ? ' · WSL' : ''}
                  </small>
                )}
              </section>

              <section class="term-side-card">
                <strong>本机回环端口映射</strong>
                {settings?.allowPortForwarding ? (
                  <form
                    class="term-inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const port = Number(targetPort.value);
                      if (!Number.isInteger(port) || port < 1 || port > 65535) {
                        onNotify('请输入有效端口号（1-65535）');
                        return;
                      }
                      busy.value = true;
                      void deviceSession
                        .api(
                          '/api/terminal/forwards',
                          {
                            method: 'POST',
                            body: JSON.stringify({ targetHost: targetHost.value.trim(), targetPort: port }),
                          },
                          TERMINAL_BACKEND_ID,
                        )
                        .then(() => refreshForwards())
                        .then(() => onNotify(`已添加 ${targetHost.value}:${port}`))
                        .catch((err) => onNotify(err instanceof Error ? err.message : '添加失败'))
                        .finally(() => {
                          busy.value = false;
                        });
                    }}
                  >
                    <input
                      type="text"
                      aria-label="转发主机"
                      value={targetHost.value}
                      placeholder="127.0.0.1"
                      onInput={(e) => {
                        targetHost.value = (e.currentTarget as HTMLInputElement).value;
                      }}
                    />
                    <input
                      type="number"
                      aria-label="转发端口"
                      value={targetPort.value}
                      min={1}
                      max={65535}
                      style="width:76px;flex:none"
                      onInput={(e) => {
                        targetPort.value = (e.currentTarget as HTMLInputElement).value;
                      }}
                    />
                    <button type="submit" class="term-action-btn primary" disabled={busy.value}>
                      添加
                    </button>
                  </form>
                ) : (
                  <p class="term-side-hint">打开上方「本机回环端口转发」开关即可添加映射与 HTTP 探测。</p>
                )}

                {forwards.value.map((fwd) => (
                  <div key={fwd.id} class="term-fwd-item">
                    <div class="term-side-card-head">
                      <span>
                        <i class="term-dot" />
                        {fwd.kind.toUpperCase()} · {fwd.display ?? `${fwd.targetHost}:${fwd.targetPort}`}
                      </span>
                      <button
                        type="button"
                        class="term-link-btn danger"
                        disabled={busy.value}
                        onClick={() => {
                          busy.value = true;
                          void deviceSession
                            .api(
                              `/api/terminal/forwards/${encodeURIComponent(fwd.id)}/close`,
                              { method: 'POST', body: '{}' },
                              TERMINAL_BACKEND_ID,
                            )
                            .then(() => refreshForwards())
                            .finally(() => {
                              busy.value = false;
                            });
                        }}
                      >
                        移除
                      </button>
                    </div>
                    <small class="term-side-meta">
                      连接 {fwd.activeConnections} · ↓{formatTransferBytes(fwd.bytesOut)} · ↑
                      {formatTransferBytes(fwd.bytesIn)}
                    </small>
                    {fwd.kind === 'tcp' && (
                      <div class="term-inline-form">
                        <input
                          type="text"
                          value={httpPath.value}
                          placeholder="/"
                          onInput={(e) => {
                            httpPath.value = (e.currentTarget as HTMLInputElement).value;
                          }}
                        />
                        <button
                          type="button"
                          class="term-action-btn"
                          disabled={busy.value}
                          onClick={() => {
                            busy.value = true;
                            void deviceSession
                              .api(
                                `/api/terminal/forwards/${encodeURIComponent(fwd.id)}/http`,
                                {
                                  method: 'POST',
                                  body: JSON.stringify({ method: 'GET', path: httpPath.value || '/' }),
                                },
                                TERMINAL_BACKEND_ID,
                              )
                              .then((raw) => {
                                const res = raw as {
                                  status: number;
                                  contentType: string;
                                  bytes: number;
                                  body?: string | null;
                                };
                                httpPreview.value = `HTTP ${res.status} (${res.contentType}, ${res.bytes} B)\n\n${
                                  res.body ?? '[二进制响应体]'
                                }`;
                              })
                              .catch((err) => {
                                httpPreview.value = err instanceof Error ? err.message : '请求失败';
                              })
                              .finally(() => {
                                busy.value = false;
                              });
                          }}
                        >
                          探测
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {httpPreview.value && <pre class="term-http-preview">{httpPreview.value}</pre>}
              </section>
            </>
          )}

          {tab === 'snippets' && (
            <>
              <div class="term-side-card-head">
                <strong>常用命令片段</strong>
                <button
                  type="button"
                  class="term-action-btn"
                  onClick={() => {
                    addSnippetOpen.value = !addSnippetOpen.value;
                  }}
                >
                  <Icon name="plus" size={13} /> 新增
                </button>
              </div>

              {addSnippetOpen.value && (
                <form
                  class="term-side-card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const title = snipTitle.value.trim();
                    const command = snipCommand.value.trim();
                    if (!title || !command) return;
                    const next = [
                      { id: `snip-${Date.now()}`, title, command, runImmediately: snipRun.value },
                      ...userSnippets.value,
                    ];
                    userSnippets.value = next;
                    saveUserSnippets(next);
                    snipTitle.value = '';
                    snipCommand.value = '';
                    addSnippetOpen.value = false;
                  }}
                >
                  <input
                    type="text"
                    placeholder="片段名称（如：查看日志）"
                    value={snipTitle.value}
                    onInput={(e) => {
                      snipTitle.value = (e.currentTarget as HTMLInputElement).value;
                    }}
                  />
                  <input
                    type="text"
                    placeholder="命令内容（如：tail -f app.log）"
                    value={snipCommand.value}
                    onInput={(e) => {
                      snipCommand.value = (e.currentTarget as HTMLInputElement).value;
                    }}
                  />
                  <label class="term-toggle-line">
                    <span>点击后立即回车执行</span>
                    <input
                      type="checkbox"
                      checked={snipRun.value}
                      onChange={(e) => {
                        snipRun.value = (e.currentTarget as HTMLInputElement).checked;
                      }}
                    />
                  </label>
                  <div style="display:flex;gap:6px;justify-content:flex-end">
                    <button
                      type="button"
                      class="term-action-btn"
                      onClick={() => {
                        addSnippetOpen.value = false;
                      }}
                    >
                      取消
                    </button>
                    <button type="submit" class="term-action-btn primary">
                      保存
                    </button>
                  </div>
                </form>
              )}

              <div class="term-snip-list">
                {allSnippets.map((snip) => (
                  <div key={snip.id} class="term-snip-item">
                    <button
                      type="button"
                      class="term-snip-main"
                      onClick={() => onRunCommand(snip.command, snip.runImmediately)}
                    >
                      <strong>{snip.title}</strong>
                      <code>{snip.command}</code>
                    </button>
                    {!snip.builtin && (
                      <button
                        type="button"
                        class="term-icon-btn xs danger"
                        title="删除片段"
                        onClick={() => {
                          const next = userSnippets.value.filter((s) => s.id !== snip.id);
                          userSnippets.value = next;
                          saveUserSnippets(next);
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    );
  };
});
