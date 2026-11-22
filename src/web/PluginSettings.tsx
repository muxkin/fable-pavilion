import { shallowRef } from 'vue';
import { tsxComponent } from './tsx-component';
import { watchRender } from './render-effects';
import { deviceSession } from './device-session';
import type { PairedHost } from './sync-store';
import type { AppRoute } from './shell/routes';
import { Icon } from './Icon';
import {
  DEFAULT_TERMINAL_PLUGIN_SETTINGS,
  TERMINAL_BACKEND_ID,
  type ManagedPluginInstance,
  type PluginManagementSnapshot,
  type TerminalPluginSettings,
} from '../shared/plugins';
import './plugin-settings.css';

const INSTANCE_TEMPLATES: Record<string, { plugin: string; config: string; secrets: string }> = {
  dsh: {
    plugin: '@agent-remote/adapter-dsh',
    config: JSON.stringify({ url: 'http://127.0.0.1:3080' }, null, 2),
    secrets: JSON.stringify({ token: 'DSH_TOKEN' }, null, 2),
  },
  codex: {
    plugin: '@agent-remote/adapter-codex',
    config: JSON.stringify({ home: '' }, null, 2),
    secrets: '{}',
  },
  antigravity: {
    plugin: '@agent-remote/adapter-antigravity',
    config: JSON.stringify({ home: '' }, null, 2),
    secrets: '{}',
  },
  custom: {
    plugin: 'my-custom-adapter',
    config: '{}',
    secrets: '{}',
  },
};

export default tsxComponent(function PluginSettings(_props: {
  navigate: (route: AppRoute, replace?: boolean) => void;
}) {
  const hosts = shallowRef<PairedHost[]>([]);
  const selectedHostId = shallowRef<string>(deviceSession.host?.hostId ?? '');
  const snapshot = shallowRef<PluginManagementSnapshot | null>(null);
  const loading = shallowRef(false);
  const busy = shallowRef(false);
  const notice = shallowRef<{ text: string; error?: boolean } | null>(null);

  const terminalConfigOpen = shallowRef(false);
  const terminalDraft = shallowRef<TerminalPluginSettings>({ ...DEFAULT_TERMINAL_PLUGIN_SETTINGS });

  const addFormOpen = shallowRef(false);
  const editingInstanceId = shallowRef<string | null>(null);
  const formId = shallowRef('');
  const formName = shallowRef('');
  const formPlugin = shallowRef('@agent-remote/adapter-dsh');
  const formVersion = shallowRef('');
  const formConfig = shallowRef('{\n  "url": "http://127.0.0.1:3080"\n}');
  const formSecrets = shallowRef('{\n  "token": "DSH_TOKEN"\n}');

  const watchHosts = watchRender();
  const watchSnapshot = watchRender();

  function syncTerminalDraft(data: PluginManagementSnapshot) {
    const terminal = data.builtins.find((item) => item.id === 'terminal');
    if (terminal) {
      terminalDraft.value = { ...DEFAULT_TERMINAL_PLUGIN_SETTINGS, ...terminal.config };
    }
  }

  function currentHost(): PairedHost | undefined {
    return hosts.value.find((h) => h.hostId === selectedHostId.value) ?? hosts.value[0];
  }

  async function loadSnapshot(host: PairedHost) {
    loading.value = true;
    notice.value = null;
    try {
      const data = await deviceSession.requestOnHost<PluginManagementSnapshot>(
        host,
        '/api/plugins/manage',
        'GET',
      );
      snapshot.value = data;
      syncTerminalDraft(data);
    } catch (error) {
      snapshot.value = null;
      notice.value = {
        text: error instanceof Error ? error.message : '无法读取该电脑的插件状态，请确认电脑在线并已升级适配器',
        error: true,
      };
    } finally {
      loading.value = false;
    }
  }

  async function runAction(task: (host: PairedHost) => Promise<void>) {
    const host = currentHost();
    if (!host || busy.value) return;
    busy.value = true;
    notice.value = null;
    try {
      await task(host);
    } catch (error) {
      notice.value = {
        text: error instanceof Error ? error.message : '插件操作未完成，请稍后重试',
        error: true,
      };
    } finally {
      busy.value = false;
    }
  }

  function openAddForm(templateKey: keyof typeof INSTANCE_TEMPLATES = 'dsh') {
    const tpl = INSTANCE_TEMPLATES[templateKey];
    editingInstanceId.value = null;
    formId.value = '';
    formName.value = '';
    formPlugin.value = tpl.plugin;
    formVersion.value = '';
    formConfig.value = tpl.config;
    formSecrets.value = tpl.secrets;
    addFormOpen.value = true;
  }

  function openEditForm(item: ManagedPluginInstance) {
    editingInstanceId.value = item.id;
    formId.value = item.id;
    formName.value = item.name;
    formPlugin.value = item.plugin;
    formVersion.value = item.version ?? '';
    formConfig.value = JSON.stringify(item.config ?? {}, null, 2);
    formSecrets.value = JSON.stringify(item.secrets ?? {}, null, 2);
    addFormOpen.value = true;
  }

  return ({ navigate }) => {
    watchHosts(() => {
      let alive = true;
      void deviceSession.cache
        .hosts(deviceSession.cache.scope)
        .then((list) => {
          if (!alive) return;
          hosts.value = list;
          if (!list.some((h) => h.hostId === selectedHostId.value)) {
            selectedHostId.value = deviceSession.host?.hostId ?? list[0]?.hostId ?? '';
          }
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [deviceSession.cache.scope]);

    const host = currentHost();
    watchSnapshot(() => {
      if (!host) {
        snapshot.value = null;
        return;
      }
      void loadSnapshot(host);
    }, [host?.hostId, host?.ticket]);

    const data = snapshot.value;
    const terminal = data?.builtins.find((item) => item.id === 'terminal');
    const platformLabel =
      data?.platform === 'windows'
        ? 'Windows'
        : data?.platform === 'macos'
          ? 'macOS'
          : data?.platform === 'linux'
            ? 'Linux'
            : '未知平台';

    return (
      <div class="settings-hierarchy-content plugin-settings-page">
        {hosts.value.length === 0 ? (
          <section class="plugin-empty-state">
            <p>尚未配对任何电脑。配对电脑并运行纯 Rust 桌面适配器后，即可在此管理内置与自定义插件。</p>
            <div>
              <button type="button" onClick={() => navigate({ page: 'add-computer' })}>
                添加电脑
              </button>
            </div>
          </section>
        ) : (
          <>
            <section class="plugin-host-bar" aria-label="目标电脑">
              <label class="plugin-host-select">
                <Icon name="monitor" size={18} />
                <select
                  aria-label="选择要管理插件的电脑"
                  value={host?.hostId ?? ''}
                  onChange={(event) => {
                    selectedHostId.value = (event.currentTarget as HTMLSelectElement).value;
                  }}
                >
                  {hosts.value.map((entry) => (
                    <option key={entry.hostId} value={entry.hostId}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <div class="plugin-host-meta">
                {data && (
                  <span>
                    <Icon
                      name={
                        data.platform === 'windows'
                          ? 'windows'
                          : data.platform === 'macos'
                            ? 'apple'
                            : 'linux'
                      }
                      size={15}
                    />{' '}
                    {platformLabel}
                  </span>
                )}
                <button
                  type="button"
                  class="secondary"
                  disabled={loading.value || busy.value || !host}
                  onClick={() => host && void loadSnapshot(host)}
                >
                  <Icon name="refresh" size={15} /> 刷新
                </button>
              </div>
            </section>

            {notice.value && (
              <p class={`plugin-notice${notice.value.error ? ' error' : ''}`} role="status">
                {notice.value.text}
              </p>
            )}

            {loading.value && !data && <div class="page-loading">正在读取电脑插件列表…</div>}

            {data && (
              <>
                <section class="settings-section" aria-labelledby="plugins-builtin-heading">
                  <h2 class="settings-section-title" id="plugins-builtin-heading">
                    内置插件
                  </h2>
                  <div class="plugin-card-list">
                    {terminal && (
                      <article class="plugin-card">
                        <div class="plugin-card-header">
                          <div class="plugin-card-title">
                            <span class="surface-icon">
                              <Icon name="terminal" size={21} />
                            </span>
                            <div class="plugin-card-copy">
                              <strong>
                                {terminal.name}
                                <span class={`plugin-badge${terminal.enabled ? ' online' : ' muted'}`}>
                                  {terminal.enabled ? '已启用' : '默认禁用'}
                                </span>
                              </strong>
                              <p>{terminal.description}</p>
                            </div>
                          </div>
                          <label class="plugin-switch">
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label="启用终端插件"
                              checked={terminal.enabled}
                              disabled={busy.value}
                              onChange={(event) => {
                                const enabled = (event.currentTarget as HTMLInputElement).checked;
                                void runAction(async (target) => {
                                  const next = await deviceSession.requestOnHost<PluginManagementSnapshot>(
                                    target,
                                    '/api/plugins/manage/builtin',
                                    'POST',
                                    { id: 'terminal', enabled },
                                  );
                                  snapshot.value = next;
                                  syncTerminalDraft(next);
                                  notice.value = {
                                    text: enabled
                                      ? '终端插件已启用，现可在工作台或下方按钮直接打开终端。'
                                      : '终端插件已禁用，当前电脑上的活动终端会话已关闭。',
                                  };
                                });
                              }}
                            />
                            <span>{terminal.enabled ? '开启' : '关闭'}</span>
                          </label>
                        </div>

                        <div class="plugin-feature-chips">
                          {terminal.features.map((feat) => (
                            <span key={feat}>{feat}</span>
                          ))}
                        </div>

                        <div class="plugin-actions-row">
                          {terminal.enabled && host && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate({
                                  page: 'workbench',
                                  host: host.hostId,
                                  backend: TERMINAL_BACKEND_ID,
                                })
                              }
                            >
                              <Icon name="terminal" size={16} /> 打开终端
                            </button>
                          )}
                          <button
                            type="button"
                            class="secondary"
                            onClick={() => {
                              terminalConfigOpen.value = !terminalConfigOpen.value;
                            }}
                          >
                            <Icon name="sliders" size={16} />{' '}
                            {terminalConfigOpen.value ? '收起配置' : '配置终端与转发'}
                          </button>
                        </div>

                        {terminalConfigOpen.value && (
                          <form
                            class="plugin-form-grid"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void runAction(async (target) => {
                                const next = await deviceSession.requestOnHost<PluginManagementSnapshot>(
                                  target,
                                  '/api/plugins/manage/builtin',
                                  'POST',
                                  { id: 'terminal', config: terminalDraft.value },
                                );
                                snapshot.value = next;
                                syncTerminalDraft(next);
                                notice.value = { text: '已保存终端插件设置' };
                              });
                            }}
                          >
                            <label class="plugin-field">
                              <span>默认 Shell（留空自动检测）</span>
                              <select
                                value={terminalDraft.value.defaultShell}
                                onChange={(event) => {
                                  terminalDraft.value = {
                                    ...terminalDraft.value,
                                    defaultShell: (event.currentTarget as HTMLSelectElement).value,
                                  };
                                }}
                              >
                                <option value="">自动检测（推荐）</option>
                                {data.availableShells.map((shell) => (
                                  <option key={shell.path} value={shell.path}>
                                    {shell.name} ({shell.path})
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label class="plugin-field">
                              <span>默认工作目录（留空使用用户主目录）</span>
                              <input
                                type="text"
                                value={terminalDraft.value.defaultCwd}
                                placeholder={data.platform === 'windows' ? 'C:\\Users\\...' : '/home/...'}
                                onInput={(event) => {
                                  terminalDraft.value = {
                                    ...terminalDraft.value,
                                    defaultCwd: (event.currentTarget as HTMLInputElement).value,
                                  };
                                }}
                              />
                            </label>

                            <label class="plugin-field">
                              <span>最大并发会话数（1-16）</span>
                              <input
                                type="number"
                                min={1}
                                max={16}
                                value={terminalDraft.value.maxSessions}
                                onInput={(event) => {
                                  terminalDraft.value = {
                                    ...terminalDraft.value,
                                    maxSessions: Math.max(
                                      1,
                                      Math.min(16, Number((event.currentTarget as HTMLInputElement).value) || 8),
                                    ),
                                  };
                                }}
                              />
                            </label>

                            <div class="plugin-checks">
                              <label class="plugin-check-item">
                                <input
                                  type="checkbox"
                                  checked={terminalDraft.value.allowOsc52Clipboard}
                                  onChange={(event) => {
                                    terminalDraft.value = {
                                      ...terminalDraft.value,
                                      allowOsc52Clipboard: (event.currentTarget as HTMLInputElement).checked,
                                    };
                                  }}
                                />
                                <span>允许 OSC 52 剪贴板写入（tmux / vim / neovim 复制同步）</span>
                              </label>
                              <label class="plugin-check-item">
                                <input
                                  type="checkbox"
                                  checked={terminalDraft.value.allowX11Forwarding}
                                  onChange={(event) => {
                                    terminalDraft.value = {
                                      ...terminalDraft.value,
                                      allowX11Forwarding: (event.currentTarget as HTMLInputElement).checked,
                                    };
                                  }}
                                />
                                <span>
                                  允许 X11 转发
                                  {terminal.hostCapabilities?.x11HostDisplay
                                    ? `（检测到本机 ${terminal.hostCapabilities.x11HostDisplay}）`
                                    : ''}
                                </span>
                              </label>
                              {data.platform !== 'windows' && (
                                <label class="plugin-check-item">
                                  <input
                                    type="checkbox"
                                    checked={terminalDraft.value.allowWaylandForwarding}
                                    onChange={(event) => {
                                      terminalDraft.value = {
                                        ...terminalDraft.value,
                                        allowWaylandForwarding: (event.currentTarget as HTMLInputElement).checked,
                                      };
                                    }}
                                  />
                                  <span>
                                    允许 Wayland 转发
                                    {terminal.hostCapabilities?.waylandHostDisplay
                                      ? `（检测到本机 ${terminal.hostCapabilities.waylandHostDisplay}）`
                                      : ''}
                                  </span>
                                </label>
                              )}
                              <label class="plugin-check-item">
                                <input
                                  type="checkbox"
                                  checked={terminalDraft.value.allowPortForwarding}
                                  onChange={(event) => {
                                    terminalDraft.value = {
                                      ...terminalDraft.value,
                                      allowPortForwarding: (event.currentTarget as HTMLInputElement).checked,
                                    };
                                  }}
                                />
                                <span>允许本机回环端口转发与 HTTP 预览（仅限 127.0.0.1 / localhost）</span>
                              </label>
                            </div>

                            <div class="plugin-actions-row">
                              <button type="submit" disabled={busy.value}>
                                保存配置
                              </button>
                            </div>
                          </form>
                        )}
                      </article>
                    )}
                  </div>
                </section>

                <section class="settings-section" aria-labelledby="plugins-instances-heading">
                  <h2 class="settings-section-title" id="plugins-instances-heading">
                    插件实例管理
                  </h2>
                  <div class="plugin-actions-row" style="margin-bottom: 10px">
                    <button type="button" onClick={() => openAddForm('dsh')} disabled={busy.value}>
                      <Icon name="plus" size={16} /> 添加插件实例
                    </button>
                  </div>

                  {addFormOpen.value && (
                    <form
                      class="plugin-card"
                      style="margin-bottom: 12px"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runAction(async (target) => {
                          let parsedConfig: Record<string, unknown>;
                          let parsedSecrets: Record<string, string>;
                          try {
                            parsedConfig = JSON.parse(formConfig.value.trim() || '{}');
                          } catch {
                            throw new Error('实例配置（config）不是有效的 JSON 对象');
                          }
                          try {
                            parsedSecrets = JSON.parse(formSecrets.value.trim() || '{}');
                          } catch {
                            throw new Error('凭据映射（secrets）不是有效的 JSON 对象');
                          }
                          const next = await deviceSession.requestOnHost<
                            PluginManagementSnapshot & { restartRecommended?: boolean }
                          >(target, '/api/plugins/manage/instances', 'POST', {
                            id: formId.value.trim(),
                            name: formName.value.trim(),
                            plugin: formPlugin.value.trim(),
                            version: formVersion.value.trim() || null,
                            enabled: true,
                            config: parsedConfig,
                            secrets: parsedSecrets,
                          });
                          snapshot.value = next;
                          addFormOpen.value = false;
                          editingInstanceId.value = null;
                          notice.value = {
                            text: next.restartRecommended
                              ? '插件实例已保存（Codex 多实例需重启桌面适配器生效）'
                              : '插件实例已保存并生效',
                          };
                        });
                      }}
                    >
                      <strong>{editingInstanceId.value ? `编辑实例：${editingInstanceId.value}` : '添加插件实例'}</strong>
                      {!editingInstanceId.value && (
                        <div class="plugin-actions-row">
                          <button type="button" class="secondary" onClick={() => openAddForm('dsh')}>
                            DSH 模板
                          </button>
                          <button type="button" class="secondary" onClick={() => openAddForm('codex')}>
                            Codex 模板
                          </button>
                          <button type="button" class="secondary" onClick={() => openAddForm('antigravity')}>
                            Antigravity 模板
                          </button>
                          <button type="button" class="secondary" onClick={() => openAddForm('custom')}>
                            自定义插件
                          </button>
                        </div>
                      )}
                      <label class="plugin-field">
                        <span>实例 ID（字母、数字、下划线或连字符）</span>
                        <input
                          type="text"
                          required
                          disabled={editingInstanceId.value !== null}
                          value={formId.value}
                          placeholder="my-dsh"
                          onInput={(e) => {
                            formId.value = (e.currentTarget as HTMLInputElement).value;
                          }}
                        />
                      </label>
                      <label class="plugin-field">
                        <span>显示名称</span>
                        <input
                          type="text"
                          required
                          value={formName.value}
                          placeholder="我的 Agent"
                          onInput={(e) => {
                            formName.value = (e.currentTarget as HTMLInputElement).value;
                          }}
                        />
                      </label>
                      <label class="plugin-field">
                        <span>插件包名</span>
                        <input
                          type="text"
                          required
                          value={formPlugin.value}
                          placeholder="@agent-remote/adapter-dsh"
                          onInput={(e) => {
                            formPlugin.value = (e.currentTarget as HTMLInputElement).value;
                          }}
                        />
                      </label>
                      <label class="plugin-field">
                        <span>固定版本（可选，留空自动使用最新兼容版本）</span>
                        <input
                          type="text"
                          value={formVersion.value}
                          placeholder="留空自动选择"
                          onInput={(e) => {
                            formVersion.value = (e.currentTarget as HTMLInputElement).value;
                          }}
                        />
                      </label>
                      <label class="plugin-field">
                        <span>实例配置 JSON（config）</span>
                        <textarea
                          rows={4}
                          value={formConfig.value}
                          onInput={(e) => {
                            formConfig.value = (e.currentTarget as HTMLTextAreaElement).value;
                          }}
                        />
                      </label>
                      <label class="plugin-field">
                        <span>凭据环境变量映射 JSON（仅填写环境变量名，不存明文密钥）</span>
                        <textarea
                          rows={3}
                          value={formSecrets.value}
                          onInput={(e) => {
                            formSecrets.value = (e.currentTarget as HTMLTextAreaElement).value;
                          }}
                        />
                      </label>
                      <div class="plugin-actions-row">
                        <button type="submit" disabled={busy.value}>
                          保存实例
                        </button>
                        <button
                          type="button"
                          class="secondary"
                          onClick={() => {
                            addFormOpen.value = false;
                            editingInstanceId.value = null;
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  )}

                  <div class="plugin-card-list">
                    {data.instances.map((item) => (
                      <article class="plugin-card" key={item.id}>
                        <div class="plugin-card-header">
                          <div class="plugin-card-title">
                            <span class="surface-icon">
                              <Icon name="puzzle" size={20} />
                            </span>
                            <div class="plugin-card-copy">
                              <strong>
                                {item.name}
                                <span
                                  class={`plugin-badge${item.enabled ? (item.connected ? ' online' : '') : ' muted'}`}
                                >
                                  {!item.enabled ? '已禁用' : item.connected ? '在线' : '已启用'}
                                </span>
                                {item.builtin && <span class="plugin-badge muted">内置发现</span>}
                              </strong>
                              <p>
                                ID: {item.id} · 插件: {item.plugin}
                                {item.currentPackage ? ` · 绑定: ${item.currentPackage}` : ''}
                              </p>
                            </div>
                          </div>
                          {item.editable && (
                            <label class="plugin-switch">
                              <input
                                type="checkbox"
                                role="switch"
                                aria-label={`启停 ${item.name}`}
                                checked={item.enabled}
                                disabled={busy.value}
                                onChange={(event) => {
                                  const enabled = (event.currentTarget as HTMLInputElement).checked;
                                  void runAction(async (target) => {
                                    const next = await deviceSession.requestOnHost<PluginManagementSnapshot>(
                                      target,
                                      `/api/plugins/manage/instances/${encodeURIComponent(item.id)}/toggle`,
                                      'POST',
                                      { id: item.id, enabled },
                                    );
                                    snapshot.value = next;
                                    notice.value = { text: `实例 ${item.name} 已${enabled ? '启用' : '禁用'}` };
                                  });
                                }}
                              />
                              <span>{item.enabled ? '启用' : '禁用'}</span>
                            </label>
                          )}
                        </div>
                        {(item.editable || item.previousPackage) && (
                          <div class="plugin-actions-row">
                            {item.editable && (
                              <>
                                <button
                                  type="button"
                                  class="secondary"
                                  disabled={busy.value}
                                  onClick={() => openEditForm(item)}
                                >
                                  编辑配置
                                </button>
                                <button
                                  type="button"
                                  class="secondary"
                                  disabled={busy.value}
                                  onClick={() => {
                                    if (!window.confirm(`确定删除插件实例「${item.name}」？`)) return;
                                    void runAction(async (target) => {
                                      const next = await deviceSession.requestOnHost<PluginManagementSnapshot>(
                                        target,
                                        `/api/plugins/manage/instances/${encodeURIComponent(item.id)}/delete`,
                                        'POST',
                                        { id: item.id },
                                      );
                                      snapshot.value = next;
                                      notice.value = { text: `已删除实例 ${item.name}` };
                                    });
                                  }}
                                >
                                  <Icon name="trash" size={15} /> 删除
                                </button>
                              </>
                            )}
                            {item.previousPackage && (
                              <button
                                type="button"
                                class="secondary"
                                disabled={busy.value}
                                onClick={() =>
                                  void runAction(async (target) => {
                                    const next = await deviceSession.requestOnHost<PluginManagementSnapshot>(
                                      target,
                                      '/api/plugins/manage/switch',
                                      'POST',
                                      { instance: item.id },
                                    );
                                    snapshot.value = next;
                                    notice.value = { text: `已提交 ${item.name} 版本回滚请求` };
                                  })
                                }
                              >
                                回滚至 {item.previousPackage}
                              </button>
                            )}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>

                <section class="settings-section" aria-labelledby="plugins-packages-heading">
                  <h2 class="settings-section-title" id="plugins-packages-heading">
                    已安装原生插件包
                  </h2>
                  <div class="plugin-card">
                    <div class="plugin-package-list">
                      {data.packages.length === 0 ? (
                        <p style="margin: 0; font-size: 13px; color: var(--muted)">
                          当前电脑尚未登记第三方原生插件包。
                        </p>
                      ) : (
                        data.packages.map((pkg) => (
                          <div class="plugin-package-item" key={pkg.key}>
                            <code>{pkg.key}</code>
                            <span class={`plugin-badge${pkg.official ? '' : ' muted'}`}>
                              {pkg.official ? '官方内置' : '自定义'} · {pkg.product}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                    <p style="margin: 0; font-size: 12px; color: var(--muted)">
                      提示：为保证安全，新的本地原生插件二进制需在该电脑的桌面适配器本机设置页「插件」标签中安装，或执行{' '}
                      <code>agent-space-native --adapter install &lt;插件目录&gt;</code>。
                    </p>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    );
  };
});
