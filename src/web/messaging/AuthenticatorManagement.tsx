import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { pasteLoginCode } from '../login-code-input';
import { Dialog } from '../shell/Dialog';
import { tsxComponent } from '../tsx-component';
import {
  beginExternalAuthenticator,
  removeExternalAuthenticator,
  trustedDevices,
  type ExternalAuthenticator,
  type TrustedDevicesState,
} from '../trusted-login';
import { messaging } from './context';
import { Notice, errorText, time } from './ui';
import './security-onboarding.css';

type Setup = { grant: string; secret: string; image: string; expiresAt: number };

export const AuthenticatorManagement = tsxComponent(function AuthenticatorManagement(props: {
  accountId: string;
}) {
  const state = shallowRef<TrustedDevicesState>();
  const setup = shallowRef<Setup>();
  const removing = shallowRef<ExternalAuthenticator>();
  const adding = shallowRef(false);
  const needsProof = shallowRef(false);
  const busy = shallowRef(false);
  const error = shallowRef('');
  const initialError = shallowRef('');
  const copied = shallowRef(false);
  const controller = new AbortController();
  let expiry: number | undefined;

  async function reload() {
    try {
      state.value = await trustedDevices(controller.signal);
      initialError.value = '';
    } catch (cause) {
      if (!controller.signal.aborted) initialError.value = errorText(cause);
    }
  }
  onMounted(() => void reload());
  function close() {
    if (busy.value) return;
    const grant = setup.value?.grant;
    window.clearTimeout(expiry);
    setup.value = undefined;
    adding.value = false;
    needsProof.value = false;
    removing.value = undefined;
    error.value = '';
    copied.value = false;
    if (grant) void messaging.request('/crypto/authenticator/cancel', 'POST', { grant }).catch(() => {});
  }
  onScopeDispose(() => {
    controller.abort();
    window.clearTimeout(expiry);
    setup.value = undefined;
  });

  async function add(credentials?: { password: string; recovery: string }) {
    if (busy.value || !state.value) return;
    busy.value = true;
    adding.value = true;
    error.value = '';
    const signal = controller.signal;
    try {
      const current = await trustedDevices(signal);
      if (!credentials && !current.recentlyVerified && !current.passkeysHere) {
        needsProof.value = true;
        return;
      }
      needsProof.value = Boolean(credentials);
      const grant = await beginExternalAuthenticator(
        props.accountId,
        credentials,
        !credentials && !current.recentlyVerified && Boolean(current.passkeysHere),
      );
      signal.throwIfAborted();
      const result = await messaging.request<{ secret: string; uri: string }>(
        '/crypto/authenticator/setup',
        'POST',
        { grant: grant.grant },
        signal,
      );
      const { default: QRCode } = await import('qrcode');
      const image = await QRCode.toDataURL(result.uri, { width: 240, margin: 4 });
      signal.throwIfAborted();
      setup.value = { ...grant, image, secret: result.secret };
      expiry = window.setTimeout(
        () => {
          setup.value = undefined;
          error.value = '设置已过期，请重新添加。';
        },
        Math.max(0, grant.expiresAt - Date.now()),
      );
    } catch (cause) {
      if (!signal.aborted) error.value = errorText(cause);
    } finally {
      busy.value = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy.value) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    form.reset();
    busy.value = true;
    error.value = '';
    try {
      if (setup.value) {
        await messaging.request(
          '/crypto/authenticator/confirm',
          'POST',
          {
            grant: setup.value.grant,
            code: String(data.get('code')),
          },
          controller.signal,
        );
        setup.value = undefined;
      } else if (removing.value) {
        await removeExternalAuthenticator(props.accountId, removing.value.id, String(data.get('password')));
      }
      busy.value = false;
      close();
      await reload();
    } catch (cause) {
      if (!controller.signal.aborted) error.value = errorText(cause);
    } finally {
      busy.value = false;
    }
  }

  return () => (
    <section aria-label="第三方验证器">
      <Notice text={initialError.value} />
      {initialError.value && (
        <button class="secondary" onClick={() => void reload()}>
          重试
        </button>
      )}
      {state.value && (
        <>
          {state.value.authenticators?.length ? (
            <ul class="im-trusted-list">
              {state.value.authenticators.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>添加于 {time(item.createdAt)}</small>
                  </div>
                  <button class="secondary" onClick={() => (removing.value = item)}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p class="im-help">还未添加第三方验证器。</p>
          )}
          {state.value.totpAvailable && (
            <button class="primary" onClick={() => void add()}>
              添加验证器
            </button>
          )}
        </>
      )}
      {(adding.value || removing.value) && (
        <Dialog title={removing.value ? '移除验证器' : '添加验证器'} onClose={close}>
          {() => (
            <div class="im-form">
              {setup.value ? (
                <>
                  <p>用验证器扫描二维码。同一台手机上可复制设置密钥。</p>
                  <img
                    class="external-authenticator-qr"
                    src={setup.value.image}
                    width={240}
                    height={240}
                    alt="验证器设置二维码"
                  />
                  <details class="authenticator-manual">
                    <summary>设置密钥</summary>
                    <code translate="no" dir="ltr">
                      {setup.value.secret}
                    </code>
                    <button
                      type="button"
                      class="secondary"
                      onClick={async () => {
                        if (!setup.value) return;
                        try {
                          await navigator.clipboard.writeText(setup.value.secret);
                          copied.value = true;
                        } catch {
                          error.value = '请选中设置密钥手动复制。';
                        }
                      }}
                    >
                      {copied.value ? '已复制' : '复制设置密钥'}
                    </button>
                  </details>
                  <form class="im-form" onSubmit={submit}>
                    <label>
                      验证器生成的六位码
                      <input
                        name="code"
                        inputmode="numeric"
                        autocomplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxlength={6}
                        required
                        onPaste={pasteLoginCode}
                      />
                    </label>
                    <button class="primary" disabled={busy.value}>
                      确认添加
                    </button>
                  </form>
                </>
              ) : removing.value ? (
                <form class="im-form" onSubmit={submit}>
                  <p>移除后，这个验证器生成的动态码将失效。</p>
                  <label>
                    当前密码
                    <input name="password" type="password" autocomplete="current-password" required />
                  </label>
                  <button class="primary" disabled={busy.value}>
                    确认移除
                  </button>
                </form>
              ) : needsProof.value ? (
                <form
                  class="im-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget as HTMLFormElement;
                    const data = new FormData(form);
                    form.reset();
                    void add({
                      password: String(data.get('password')),
                      recovery: String(data.get('recovery')),
                    });
                  }}
                >
                  <p>用密码和恢复码确认身份。也可在另一台设备确认扫码登录，再添加验证器。</p>
                  <label>
                    当前密码
                    <input name="password" type="password" autocomplete="current-password" required />
                  </label>
                  <label>
                    恢复码
                    <input name="recovery" type="password" autocomplete="off" required />
                  </label>
                  <button class="primary" disabled={busy.value}>
                    继续
                  </button>
                </form>
              ) : busy.value ? (
                <p role="status">正在验证身份…</p>
              ) : (
                <button class="secondary" onClick={() => void add()}>
                  重试
                </button>
              )}
              <Notice text={error.value} />
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
});
