import { onMounted, onScopeDispose, shallowRef, type VNodeChild } from 'vue';
import { deviceLoginMatchCode } from '../../shared/trusted-device-crypto';
import type { ChatUser } from '../../shared/messaging';
import { Icon } from '../Icon';
import { QrScanner } from '../QrScanner';
import { tsxComponent } from '../tsx-component';
import { pasteLoginCode } from '../login-code-input';
import {
  claimQrInvitation,
  checkQrLogin,
  InvitationAtAnotherSite,
  parseQrInvitationUrl,
  qrLoginUrl,
  startQrLogin,
  switchAndroidLoginSite,
  type QrInvitationCredentials,
  type QrLoginHandle,
  type TrustedLoginRequest,
} from '../trusted-login';
import { Notice, errorText } from './ui';
import './trusted-login.css';
import './login-entry.css';

export type PasswordChallenge = { request: TrustedLoginRequest; password: string };
export const defaultTrustedDeviceName = /\bFablePavilionAndroid\//.test(navigator.userAgent)
  ? 'Android 手机'
  : '当前浏览器';
export const loginMatchCode = (id: string) => id.slice(0, 6).toUpperCase();

export const TrustedCodeForm = tsxComponent(function TrustedCodeForm(props: {
  request: TrustedLoginRequest;
  onVerify: (code: string) => Promise<void>;
  onCancel: (expired?: boolean) => void;
}) {
  const busy = shallowRef(false);
  const error = shallowRef('');
  const input = shallowRef<HTMLInputElement>();
  let expired = false;
  const expiry = window.setTimeout(
    () => {
      expired = true;
      if (!busy.value) props.onCancel(true);
    },
    Math.max(0, props.request.expiresAt - Date.now()),
  );
  onMounted(() => input.value?.focus());
  onScopeDispose(() => window.clearTimeout(expiry));

  return ({ request, onVerify, onCancel }) => (
    <form
      class="im-form im-trusted-challenge"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy.value) return;
        if (expired) {
          onCancel(true);
          return;
        }
        const code = String(new FormData(event.currentTarget as HTMLFormElement).get('trustedCode'));
        busy.value = true;
        error.value = '';
        try {
          await onVerify(code);
        } catch (cause) {
          if (expired) onCancel(true);
          else error.value = errorText(cause);
        } finally {
          busy.value = false;
        }
      }}
    >
      <p>请在已登录设备的「我的 → 登录与安全」查看当前动态码。动态码每 30 秒更新。</p>
      <label>
        6 位登录动态码
        <input
          ref={input}
          name="trustedCode"
          type="text"
          required
          inputmode="numeric"
          autocomplete="one-time-code"
          onPaste={pasteLoginCode}
          pattern="[0-9]{6}"
          maxlength={6}
          disabled={busy.value}
        />
      </label>
      <Notice text={error.value} />
      <button class="primary" disabled={busy.value}>
        {busy.value ? '正在验证…' : '验证并继续'}
      </button>
      <button type="button" class="secondary" disabled={busy.value} onClick={() => onCancel()}>
        返回密码输入
      </button>
    </form>
  );
});

interface ActiveQr {
  code: string;
  image?: string;
  expiresAt: number;
  confirmed: boolean;
}

function useQrLogin(onLogin: (user: ChatUser) => void) {
  const active = shallowRef<ActiveQr>();
  const busy = shallowRef(false);
  const error = shallowRef('');
  let operation: AbortController | undefined;
  let pending: QrLoginHandle | undefined;
  let pollTimer: number | undefined;
  let expiryTimer: number | undefined;

  function cancel() {
    operation?.abort();
    operation = undefined;
    pending = undefined;
    window.clearTimeout(pollTimer);
    window.clearTimeout(expiryTimer);
    active.value = undefined;
    busy.value = false;
  }
  onScopeDispose(cancel);

  async function poll(handle: QrLoginHandle, signal: AbortSignal) {
    try {
      const result = await checkQrLogin(handle, signal);
      if (signal.aborted) return;
      if ('pending' in result) pollTimer = window.setTimeout(() => void poll(handle, signal), 2500);
      else {
        cancel();
        onLogin(result.user);
      }
    } catch (cause) {
      if (signal.aborted) return;
      cancel();
      error.value = errorText(cause);
    }
  }

  async function start(
    prepare: (signal: AbortSignal) => Promise<{ handle: QrLoginHandle; image?: string }>,
    expiryMessage: string,
    pollImmediately = false,
  ) {
    if (operation) return;
    const controller = new AbortController();
    operation = controller;
    busy.value = true;
    error.value = '';
    try {
      const { handle, image } = await prepare(controller.signal);
      if (controller.signal.aborted) return;
      const code = handle.deviceBound
        ? await deviceLoginMatchCode(handle.id, handle.key.publicKey)
        : loginMatchCode(handle.id);
      if (controller.signal.aborted) return;
      pending = handle;
      active.value = { code, image, expiresAt: handle.expiresAt, confirmed: false };
      expiryTimer = window.setTimeout(
        () => {
          cancel();
          error.value = expiryMessage;
        },
        Math.max(0, handle.expiresAt - Date.now()),
      );
      if (pollImmediately) confirm();
    } catch (cause) {
      if (controller.signal.aborted) return;
      cancel();
      error.value = errorText(cause);
    } finally {
      if (!controller.signal.aborted) busy.value = false;
    }
  }
  function confirm() {
    const request = active.value;
    if (!request || request.confirmed || !pending || !operation || request.expiresAt <= Date.now()) return;
    active.value = { ...request, confirmed: true };
    void poll(pending, operation.signal);
  }

  return { active, busy, error, start, confirm, cancel };
}

export const LoginExpiry = tsxComponent(function LoginExpiry(_props: { expiresAt: number }) {
  const now = shallowRef(Date.now());
  const interval = window.setInterval(() => (now.value = Date.now()), 1000);
  onScopeDispose(() => window.clearInterval(interval));
  return ({ expiresAt }) => {
    const seconds = Math.max(0, Math.ceil((expiresAt - now.value) / 1000));
    return (
      <time datetime={new Date(expiresAt).toISOString()}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} 后失效
      </time>
    );
  };
});

export function LoginQrSteps({ confirming = false }: { confirming?: boolean }) {
  return (
    <ol class="login-qr-steps" aria-label="扫码登录步骤">
      <li data-current={!confirming}>
        <span>{confirming ? <Icon name="check" size={15} /> : '1'}</span>扫码
      </li>
      <li data-current={confirming}>
        <span>2</span>确认登录
      </li>
    </ol>
  );
}

function QrLoginConfirmation({
  code,
  confirmed,
  onConfirm,
}: {
  code: string;
  confirmed: boolean;
  onConfirm: () => void;
}) {
  return (
    <div class="login-qr-waiting" role="status">
      <p class="login-match-label">核对两台设备上的代码</p>
      <strong class="im-trusted-match" translate="no">
        {code}
      </strong>
      {confirmed ? (
        <p class="im-help">正在等待已登录设备确认…</p>
      ) : (
        <button type="button" class="primary" onClick={onConfirm}>
          代码一致，确认登录
        </button>
      )}
    </div>
  );
}

export const TrustedQrForm = tsxComponent(function TrustedQrForm(props: {
  onLogin: (user: ChatUser) => void;
  onPassword?: () => void;
}) {
  const { active, busy, error, start, confirm, cancel } = useQrLogin(props.onLogin);
  const showingCode = shallowRef(false);

  async function generate() {
    showingCode.value = true;
    await start(
      async (signal) => {
        const [handle, { default: QRCode }] = await Promise.all([
          startQrLogin(undefined, defaultTrustedDeviceName, signal),
          import('qrcode'),
        ]);
        const image = await QRCode.toDataURL(await qrLoginUrl(handle), { width: 320, margin: 4 });
        return { handle, image };
      },
      '二维码已过期，请重新生成',
      true,
    );
  }

  function back() {
    cancel();
    showingCode.value = false;
    error.value = '';
  }

  return ({ onLogin, onPassword }) => {
    if (active.value) {
      return (
        <div class="im-form im-trusted-qr login-local-code">
          <LoginQrSteps />
          <div class="login-qr-instructions">
            <h2>请已登录的设备扫描</h2>
            <p>在已登录设备打开「我的 → 登录与安全」，点击「扫描新设备二维码」。</p>
          </div>
          <div class="login-qr-code">
            <img src={active.value.image} width={264} height={264} alt="可信设备扫码登录二维码" />
          </div>
          <p class="login-current-device">
            当前设备：<strong>{defaultTrustedDeviceName}</strong>
          </p>
          <div class="login-qr-expiry">
            <span>
              <Icon name="clock" size={18} />
              <LoginExpiry expiresAt={active.value.expiresAt} />
            </span>
            <button
              type="button"
              disabled={busy.value}
              onClick={() => {
                cancel();
                void generate();
              }}
            >
              <Icon name="refresh" size={18} />
              刷新二维码
            </button>
          </div>
          <QrLoginConfirmation
            code={active.value.code}
            confirmed={active.value.confirmed}
            onConfirm={confirm}
          />
          <button type="button" class="secondary login-switch-direction" onClick={back}>
            <Icon name="camera" size={20} />
            改为扫描已登录设备
          </button>
        </div>
      );
    }
    return (
      <div class="account-qr-options login-qr-options">
        {showingCode.value ? (
          <div class="im-form login-local-code-form">
            <div class="login-qr-instructions">
              <h2>出示本机登录码</h2>
              {busy.value && <p role="status">正在生成登录二维码…</p>}
            </div>
            <Notice text={error.value} />
            {!busy.value && (
              <button type="button" class="primary" onClick={() => void generate()}>
                <Icon name="grid" size={21} />
                重新生成二维码
              </button>
            )}
            <button type="button" class="text-button" onClick={back}>
              <Icon name="back" size={18} />
              返回扫码登录
            </button>
          </div>
        ) : (
          <TrustedInvitationReceiver
            onLogin={onLogin}
            onCancel={onPassword}
            localCodeAction={
              <button
                type="button"
                class="secondary login-local-code-action"
                disabled={busy.value}
                onClick={() => void generate()}
              >
                <Icon name="grid" size={22} />
                出示本机登录码
              </button>
            }
          />
        )}
      </div>
    );
  };
});

export const TrustedInvitationReceiver = tsxComponent(function TrustedInvitationReceiver(props: {
  invitation?: QrInvitationCredentials;
  onLogin: (user: ChatUser) => void;
  onCancel?: () => void;
  localCodeAction?: VNodeChild;
}) {
  const otherSite = shallowRef<URL>();
  const { active, busy, error, start, confirm, cancel } = useQrLogin(props.onLogin);

  function claim(credentials: QrInvitationCredentials) {
    return start(
      async (signal) => ({ handle: await claimQrInvitation(credentials, defaultTrustedDeviceName, signal) }),
      '二维码已过期，请在已登录设备上刷新。',
    );
  }
  onMounted(() => {
    if (props.invitation) void claim(props.invitation);
  });

  return ({ onCancel, localCodeAction }) => (
    <div
      class={`im-form im-trusted-qr login-invitation-receiver${localCodeAction ? ' login-device-actions' : ''}`}
    >
      {active.value ? (
        <>
          <LoginQrSteps confirming />
          <QrLoginConfirmation
            code={active.value.code}
            confirmed={active.value.confirmed}
            onConfirm={confirm}
          />
        </>
      ) : busy.value ? (
        <p class="im-help" role="status">
          正在读取登录请求…
        </p>
      ) : otherSite.value ? (
        <div class="im-form login-invitation-claim">
          <p class="im-help">请在二维码所属站点继续登录。</p>
          <a class="primary" href={otherSite.value.href} referrerpolicy="no-referrer">
            在 {otherSite.value.hostname} 继续
          </a>
          <button
            class="text-button"
            type="button"
            onClick={() => {
              otherSite.value = undefined;
            }}
          >
            重新扫码
          </button>
        </div>
      ) : (
        <>
          {!localCodeAction && <p class="login-scan-instruction">扫描已登录设备上的登录二维码。</p>}
          <QrScanner
            className="login-invitation-scanner"
            actionIcons
            scanIcon={!!localCodeAction}
            cameraAction={localCodeAction ? '扫描登录二维码' : '扫描已登录设备的登录二维码'}
            cameraLabel="邀请扫码相机"
            imageAction={localCodeAction ? '从相册导入' : '相册导入'}
            imageLabel="导入邀请二维码图片"
            onScan={(text) => {
              try {
                void claim(parseQrInvitationUrl(text));
              } catch (failure) {
                if (!(failure instanceof InvitationAtAnotherSite)) throw failure;
                if (!switchAndroidLoginSite(failure.url)) otherSite.value = failure.url;
              }
            }}
          />
          {localCodeAction}
          {localCodeAction && <p class="login-scan-instruction">在已登录设备的「登录与安全」中出示二维码</p>}
        </>
      )}
      <Notice text={error.value} />
      {(onCancel || active.value || busy.value) && (
        <button
          type="button"
          class="text-button login-scanner-back"
          onClick={() => {
            const fromScan = !!active.value || busy.value;
            cancel();
            if (!localCodeAction || !fromScan) onCancel?.();
          }}
        >
          <Icon name="back" size={20} />
          {active.value ? '取消登录邀请' : '返回'}
        </button>
      )}
    </div>
  );
});
