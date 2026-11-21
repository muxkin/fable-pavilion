import { onMounted, onScopeDispose, shallowRef } from 'vue';
import QRCode from 'qrcode';
import type { ChatUser } from '../shared/messaging';
import { Icon } from '../web/Icon';
import { tsxComponent } from '../web/tsx-component';
import { adminApi, type AdminAuthChallenge, type SiteStatus } from './api';
import { resolvedLocale, t, toggleLocale } from '../shared/i18n';

type LoginTab = 'handoff' | 'recovery';

export const AdminLogin = tsxComponent(function AdminLogin(initialProps: {
  status: SiteStatus | null;
  onAuthenticated: (user: ChatUser) => void;
}) {
  const tab = shallowRef<LoginTab>('handoff');
  const challenge = shallowRef<AdminAuthChallenge | null>(null);
  const qrDataUrl = shallowRef('');
  const remainingSec = shallowRef(0);
  const busy = shallowRef(false);
  const error = shallowRef('');
  const identifier = shallowRef('');
  const secret = shallowRef('');
  const usePassword = shallowRef(false);
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  let disposed = false;
  let onAuthCallback = initialProps.onAuthenticated;

  function stopPolling() {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  }

  onScopeDispose(() => {
    disposed = true;
    stopPolling();
  });

  async function startHandoff() {
    stopPolling();
    busy.value = true;
    error.value = '';
    challenge.value = null;
    qrDataUrl.value = '';
    try {
      const next = await adminApi.startAdminAuth();
      if (disposed) return;
      challenge.value = next;
      remainingSec.value = Math.max(0, Math.ceil((next.expiresAt - Date.now()) / 1000));
      qrDataUrl.value = await QRCode.toDataURL(next.approveUrl, {
        width: 220,
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      tickTimer = window.setInterval(() => {
        if (!challenge.value) return;
        const left = Math.max(0, Math.ceil((challenge.value.expiresAt - Date.now()) / 1000));
        remainingSec.value = left;
        if (left <= 0) {
          stopPolling();
          error.value = '授权码已过期，请重新生成。';
        }
      }, 1000);
      pollTimer = window.setInterval(() => {
        const current = challenge.value;
        if (!current) return;
        void adminApi
          .pollAdminAuth(current.id, current.secret)
          .then((res) => {
            if (!res.pending && res.user) {
              stopPolling();
              onAuthCallback(res.user);
            }
          })
          .catch((cause) => {
            stopPolling();
            error.value = cause instanceof Error ? cause.message : '授权已失效，请重新生成';
          });
      }, 2000);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '无法发起授权请求';
    } finally {
      busy.value = false;
    }
  }

  onMounted(() => {
    if (tab.value === 'handoff' && !challenge.value && !busy.value) {
      void startHandoff();
    }
  });

  return ({ status, onAuthenticated }) => {
    onAuthCallback = onAuthenticated;

    async function submitSecret(e: Event) {
      e.preventDefault();
      if (busy.value || !identifier.value.trim() || !secret.value.trim()) return;
      busy.value = true;
      error.value = '';
      try {
        const recovery = status?.deviceLoginOnly ? true : !usePassword.value;
        const { user } = await adminApi.loginWithSecret(
          identifier.value.trim(),
          secret.value.trim(),
          recovery,
        );
        secret.value = '';
        onAuthCallback(user);
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '登录失败，请检查凭据';
      } finally {
        busy.value = false;
      }
    }

    const current = challenge.value;
    return (
      <div class="adm-auth-shell">
        <div class="adm-auth-card">
          <div class="adm-auth-brand">
            <span class="adm-brand-mark" aria-hidden="true">
              亭
            </span>
            <div style="flex: 1; min-width: 0">
              <h1>{t('子虚亭 · 管理台', 'Fable Pavilion · Console')}</h1>
              <p>Fable Pavilion Operations Console</p>
            </div>
            <button
              type="button"
              class="adm-btn is-sm"
              aria-label={t('切换语言为 English', 'Switch language to Chinese')}
              onClick={toggleLocale}
            >
              <Icon name="globe" size={14} />
              <span>{resolvedLocale.value === 'en' ? '中文' : 'EN'}</span>
            </button>
          </div>

          <div class="adm-auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab.value === 'handoff'}
              class={tab.value === 'handoff' ? 'is-active' : ''}
              onClick={() => {
                tab.value = 'handoff';
                error.value = '';
                if (!challenge.value || remainingSec.value <= 0) {
                  void startHandoff();
                }
              }}
            >
              <Icon name="scan" size={16} />
              <span>主站授权登录</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab.value === 'recovery'}
              class={tab.value === 'recovery' ? 'is-active' : ''}
              onClick={() => {
                tab.value = 'recovery';
                error.value = '';
                stopPolling();
              }}
            >
              <Icon name="key" size={16} />
              <span>{status?.deviceLoginOnly ? '恢复码登录' : '恢复码 / 密码'}</span>
            </button>
          </div>

          {error.value && (
            <div class="adm-alert is-error" role="alert">
              <Icon name="info" size={16} />
              <span>{error.value}</span>
            </div>
          )}

          {tab.value === 'handoff' ? (
            <div class="adm-handoff-panel">
              <p class="adm-muted">
                使用已登录的管理员设备扫码，或点击下方按钮在主站确认核对码即可登录。
              </p>
              <div class="adm-qr-stage">
                {qrDataUrl.value ? (
                  <img src={qrDataUrl.value} alt="管理后台登录授权二维码" width={196} height={196} />
                ) : (
                  <div class="adm-qr-placeholder">{busy.value ? '正在生成授权码…' : '等待生成'}</div>
                )}
              </div>
              {current && (
                <div class="adm-code-box">
                  <span>核对码</span>
                  <strong>
                    {current.code.slice(0, 3)} {current.code.slice(3)}
                  </strong>
                  <small>{remainingSec.value > 0 ? `剩余 ${remainingSec.value} 秒` : '已过期'}</small>
                </div>
              )}
              <div class="adm-handoff-actions">
                {current && remainingSec.value > 0 && (
                  <a
                    class="adm-btn is-primary"
                    href={current.approveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon name="external" size={16} />
                    <span>前往主站确认授权</span>
                  </a>
                )}
                <button
                  type="button"
                  class="adm-btn"
                  disabled={busy.value}
                  onClick={() => void startHandoff()}
                >
                  <Icon name="refresh" size={15} />
                  <span>重新生成</span>
                </button>
              </div>
            </div>
          ) : (
            <form class="adm-login-form" onSubmit={submitSecret}>
              <label class="adm-field">
                <span>管理员 UID 或用户名</span>
                <input
                  type="text"
                  required
                  autocomplete="username"
                  placeholder="例如 10000000 或 username"
                  value={identifier.value}
                  onInput={(e: Event) => (identifier.value = (e.target as HTMLInputElement).value)}
                />
              </label>
              {!status?.deviceLoginOnly && (
                <div class="adm-inline-toggle">
                  <button
                    type="button"
                    class={!usePassword.value ? 'is-active' : ''}
                    onClick={() => (usePassword.value = false)}
                  >
                    恢复码
                  </button>
                  <button
                    type="button"
                    class={usePassword.value ? 'is-active' : ''}
                    onClick={() => (usePassword.value = true)}
                  >
                    账号密码
                  </button>
                </div>
              )}
              <label class="adm-field">
                <span>{status?.deviceLoginOnly || !usePassword.value ? '恢复码' : '密码'}</span>
                <input
                  type="password"
                  required
                  autocomplete="current-password"
                  placeholder={status?.deviceLoginOnly || !usePassword.value ? '输入账号恢复码' : '输入账号密码'}
                  value={secret.value}
                  onInput={(e: Event) => (secret.value = (e.target as HTMLInputElement).value)}
                />
              </label>
              <button type="submit" class="adm-btn is-primary" disabled={busy.value}>
                <Icon name="shield" size={16} />
                <span>{busy.value ? '验证中…' : '验证并进入管理台'}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    );
  };
});
