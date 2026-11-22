import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender } from '../render-effects';
import { deviceSession } from '../device-session';
import { Icon } from '../Icon';
import {
  TERMINAL_BACKEND_ID,
  type TerminalForwardSummary,
  type TerminalHostCapabilities,
  type TerminalPluginSettings,
  type TerminalSessionSummary,
} from '../../shared/plugins';
import { formatTransferBytes } from './shell-escape';

export const TerminalForwardDrawer = tsxComponent(function TerminalForwardDrawer(_props: {
  session: TerminalSessionSummary | null;
  settings: TerminalPluginSettings | null;
  capabilities: TerminalHostCapabilities | null;
  onClose: () => void;
  onNotify: (msg: string) => void;
}) {
  const forwards = shallowRef<TerminalForwardSummary[]>([]);
  const targetHost = shallowRef('127.0.0.1');
  const targetPort = shallowRef('8080');
  const httpPath = shallowRef('/');
  const httpPreview = shallowRef<string>('');
  const downloadPath = shallowRef('');
  const busy = shallowRef(false);
  const watchLoad = watchRender();

  async function refresh() {
    try {
      const res = (await deviceSession.api(
        '/api/terminal/forwards',
        { method: 'GET' },
        TERMINAL_BACKEND_ID,
      )) as { forwards?: TerminalForwardSummary[] };
      forwards.value = res.forwards ?? [];
    } catch {
      forwards.value = [];
    }
  }

  return ({ session, settings, capabilities, onClose, onNotify }) => {
    watchLoad(() => {
      void refresh();
    }, [session?.id]);

    return (
      <aside class="terminal-drawer" aria-label="转发与文件工具">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
          <h3>现代终端扩展（转发 / 文件）</h3>
          <button type="button" class="terminal-btn" onClick={onClose} aria-label="关闭面板">
            <Icon name="close" size={14} />
          </button>
        </div>

        <section class="terminal-drawer-card">
          <strong>显示转发（X11 / Wayland）</strong>
          <small style="color: #9bb0be">
            X11 转发：{settings?.allowX11Forwarding ? '已允许' : '未开启（在插件管理开启）'}
            {session?.x11Display ? ` · 当前 DISPLAY=${session.x11Display}` : ''}
          </small>
          <small style="color: #9bb0be">
            Wayland 转发：{settings?.allowWaylandForwarding ? '已允许' : '未开启'}
            {session?.waylandDisplay ? ` · WAYLAND_DISPLAY=${session.waylandDisplay}` : ''}
          </small>
          {capabilities && (
            <small style="color: #7d96a6">
              宿主机环境：PTY={capabilities.ptyBackend}
              {capabilities.x11HostDisplay ? ` · 宿主机 DISPLAY=${capabilities.x11HostDisplay}` : ''}
              {capabilities.waylandHostDisplay ? ` · 宿主机 Wayland=${capabilities.waylandHostDisplay}` : ''}
              {capabilities.hasXvfb ? ' · Xvfb' : ''}
              {capabilities.hasXpra ? ' · Xpra' : ''}
              {capabilities.hasWaypipe ? ' · Waypipe' : ''}
              {capabilities.hasWsl ? ' · WSL' : ''}
            </small>
          )}
        </section>

        <section class="terminal-drawer-card">
          <strong>本机回环端口转发</strong>
          {!settings?.allowPortForwarding ? (
            <small style="color: #9bb0be">尚未允许端口转发，请在「设置 → 插件管理 → 终端」中开启。</small>
          ) : (
            <form
              style="display: grid; gap: 6px"
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
                  .then(() => refresh())
                  .then(() => onNotify(`已添加端口转发 ${targetHost.value}:${port}`))
                  .catch((error) => onNotify(error instanceof Error ? error.message : '添加端口转发失败'))
                  .finally(() => {
                    busy.value = false;
                  });
              }}
            >
              <div style="display: flex; gap: 6px">
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
                  style="max-width: 96px"
                  onInput={(e) => {
                    targetPort.value = (e.currentTarget as HTMLInputElement).value;
                  }}
                />
              </div>
              <button type="submit" class="terminal-btn" disabled={busy.value}>
                <Icon name="plus" size={14} /> 添加本机转发
              </button>
            </form>
          )}

          {forwards.value.map((fwd) => (
            <div
              key={fwd.id}
              style="display: grid; gap: 6px; padding: 8px; border-radius: 8px; background: rgba(0,0,0,0.22)"
            >
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px">
                <span>
                  [{fwd.kind.toUpperCase()}] {fwd.display ?? `${fwd.targetHost}:${fwd.targetPort}`}
                </span>
                <button
                  type="button"
                  class="terminal-btn"
                  disabled={busy.value}
                  onClick={() => {
                    busy.value = true;
                    void deviceSession
                      .api(
                        `/api/terminal/forwards/${encodeURIComponent(fwd.id)}/close`,
                        { method: 'POST', body: '{}' },
                        TERMINAL_BACKEND_ID,
                      )
                      .then(() => refresh())
                      .finally(() => {
                        busy.value = false;
                      });
                  }}
                >
                  关闭
                </button>
              </div>
              <small style="color: #8ea5b4">
                活动连接 {fwd.activeConnections} · ↓{formatTransferBytes(fwd.bytesOut)} · ↑
                {formatTransferBytes(fwd.bytesIn)}
              </small>
              {fwd.kind === 'tcp' && (
                <div style="display: flex; gap: 6px">
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
                    class="terminal-btn"
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
                    GET 探测
                  </button>
                </div>
              )}
            </div>
          ))}
          {httpPreview.value && <pre>{httpPreview.value}</pre>}
        </section>

        {session && (
          <section class="terminal-drawer-card">
            <strong>快速下载宿主机文件</strong>
            <small style="color: #9bb0be">
              也可在终端直接运行 <code>sz &lt;文件&gt;</code>（lrzsz）或 <code>tsz &lt;文件&gt;</code>（trzsz）
            </small>
            <form
              style="display: flex; gap: 6px"
              onSubmit={(event) => {
                event.preventDefault();
                const path = downloadPath.value.trim();
                if (!path) return;
                busy.value = true;
                void deviceSession
                  .rpcBinary<{ name: string; size: number }>(
                    `/api/terminal/sessions/${encodeURIComponent(session.id)}/download`,
                    'POST',
                    { path },
                    undefined,
                    TERMINAL_BACKEND_ID,
                  )
                  .then(({ value, bytes }) => {
                    if (!bytes) throw new Error('未读取到文件内容');
                    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = value.name || 'download.bin';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                    onNotify(`已下载 ${value.name}（${formatTransferBytes(value.size)}）`);
                  })
                  .catch((error) => onNotify(error instanceof Error ? error.message : '下载失败'))
                  .finally(() => {
                    busy.value = false;
                  });
              }}
            >
              <input
                type="text"
                value={downloadPath.value}
                placeholder="相对路径或绝对路径"
                onInput={(e) => {
                  downloadPath.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
              <button type="submit" class="terminal-btn" disabled={busy.value}>
                <Icon name="download" size={14} /> 下载
              </button>
            </form>
          </section>
        )}
      </aside>
    );
  };
});
