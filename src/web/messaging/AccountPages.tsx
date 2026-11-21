import { tsxComponent } from '../tsx-component';
import { nextTick, onScopeDispose, shallowRef, useId } from 'vue';
import { watchRender, writeRef } from '../render-effects';

import { Icon } from '../Icon';
import { peekStartupStatus, takeStartupLoginMode, type StartupAccountStatus } from '../startup-session';
import loginArtwork from './assets/login-art.webp';
import { deviceLoginRequired, messaging, useMessaging } from './context';
import { Notice as ErrorNotice, errorText } from './ui';
import {
  TrustedCodeForm,
  TrustedQrForm,
  defaultTrustedDeviceName,
  type PasswordChallenge,
} from './TrustedLogin';
import { TrustedLoginRequired, completeTrustedLogin } from '../trusted-login';
import './account-flow.css';
import './login-entry.css';
import './signed-out.css';
import '../shell/settings-hierarchy.css';

type AccountMode = 'register' | 'login' | 'recovery' | 'qr';

function resolveArtworkSource(baseUrl?: string): string {
  if (baseUrl) {
    try {
      const base = new URL(baseUrl);
      if (base.protocol === 'https:') return new URL(`assets/${loginArtwork.split('/').at(-1)}`, base).href;
    } catch {}
  }
  return loginArtwork;
}

export const AccountForm = tsxComponent(function AccountForm(_props: { description?: string }) {
  const initialStatus = peekStartupStatus();
  const initialDeviceOnly = deviceLoginRequired || initialStatus?.deviceLoginOnly === true;
  const modeState = shallowRef<AccountMode>(takeStartupLoginMode() ?? 'qr');
  const setMode = writeRef(modeState);
  const challenge = shallowRef<PasswordChallenge>();
  const requiresCodeState = shallowRef(initialStatus?.registrationRequiresCode === true);
  const registrationEnabled = shallowRef<boolean | undefined>(
    initialStatus ? initialStatus.registrationEnabled === true : undefined,
  );
  const artworkSource = shallowRef<string | undefined>(
    initialStatus ? resolveArtworkSource(initialStatus.loginArtworkBase) : undefined,
  );
  const deviceOnly = shallowRef(initialDeviceOnly);
  const setRequiresCode = writeRef(requiresCodeState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const watchRequiresCode = watchRender();
  const heading = shallowRef<HTMLHeadingElement | null>(null);
  const formElement = shallowRef<HTMLFormElement | null>(null);
  const recoveryInput = shallowRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const recoveryCode = shallowRef('');
  const recoveryVisible = shallowRef(false);
  const recoveryId = useId();
  onScopeDispose(() => {
    recoveryCode.value = '';
    recoveryVisible.value = false;
  });
  return ({ description = '使用已登录的设备快速登录。' }) => {
    const { setUser } = useMessaging();
    const mode = modeState.value;
    const requiresCode = requiresCodeState.value;
    const error = errorState.value;
    const busy = busyState.value;
    const pending = challenge.value;
    const signingIn = mode === 'login' || mode === 'qr';
    watchRequiresCode(() => {
      if (initialStatus) return;
      const controller = new AbortController();
      void messaging
        .request<StartupAccountStatus>('/status', 'GET', undefined, controller.signal)
        .then((v) => {
          if (controller.signal.aborted) return;
          registrationEnabled.value = v.registrationEnabled === true;
          setRequiresCode(v.registrationRequiresCode);
          deviceOnly.value = deviceLoginRequired || v.deviceLoginOnly === true;
          if (deviceOnly.value && modeState.value === 'login') setMode('qr');
          artworkSource.value = resolveArtworkSource(v.loginArtworkBase);
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) artworkSource.value ??= loginArtwork;
        });
      return () => controller.abort();
    }, []);
    async function submit(event: SubmitEvent) {
      event.preventDefault();
      if (busyState.value) return;
      setError('');
      if (mode === 'register' && !registrationEnabled.value) {
        setError('本站已关闭注册，请使用已有账号登录。');
        return;
      }
      setBusy(true);
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const password = String(data.get('password'));
      try {
        const result =
          mode === 'register'
            ? await messaging.account.register(
                String(data.get('username')),
                String(data.get('displayName')),
                password,
                data.get('registrationCode') ? String(data.get('registrationCode')) : undefined,
                deviceOnly.value,
              )
            : await messaging.account.login(String(data.get('identifier')), password, mode === 'recovery', {
                trusted: true,
                deviceName: defaultTrustedDeviceName,
              });
        if (mode === 'recovery') {
          recoveryCode.value = '';
          recoveryVisible.value = false;
          form.reset();
        }
        setUser(result.user);
      } catch (error) {
        if (error instanceof TrustedLoginRequired && mode === 'login') {
          form.reset();
          challenge.value = { request: error.request, password };
        } else setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    function switchMode(next: AccountMode) {
      formElement.value?.reset();
      recoveryCode.value = '';
      recoveryVisible.value = false;
      challenge.value = undefined;
      setMode(next);
      setError('');
      if (!signingIn || next === 'register' || next === 'recovery')
        void nextTick(() => heading.value?.focus({ preventScroll: true }));
    }
    return (
      <section
        class={`pavilion-flow-content account-entry secure-login-entry${mode === 'recovery' ? ' account-recovery-mode' : ''}`}
      >
        <header class="account-entry-header">
          <h1 ref={heading} tabindex={-1} class="pavilion-flow-title">
            {mode === 'register' ? '创建子虚亭账号' : mode === 'recovery' ? '恢复子虚亭账号' : '登录子虚亭'}
          </h1>
        </header>
        {signingIn && <p class="pavilion-flow-description">{description}</p>}
        {mode === 'recovery' && (
          <p class="pavilion-flow-description">动态码不可用时，用保存的恢复码恢复账号。</p>
        )}
        {signingIn && !deviceOnly.value && (
          <div class="account-entry-methods" role="group" aria-label="登录方式">
            <button
              type="button"
              aria-pressed={mode === 'qr'}
              disabled={busy || !!pending}
              onClick={() => switchMode('qr')}
            >
              <Icon name="camera" size={22} />
              扫码登录
            </button>
            <button
              type="button"
              aria-pressed={mode === 'login'}
              disabled={busy || !!pending}
              onClick={() => switchMode('login')}
            >
              使用账号密码
            </button>
          </div>
        )}
        {mode === 'qr' ? (
          <TrustedQrForm
            onLogin={setUser}
            onPassword={deviceOnly.value ? undefined : () => switchMode('login')}
          />
        ) : pending ? (
          <TrustedCodeForm
            key={pending.request.id}
            request={pending.request}
            onVerify={async (code) => {
              const result = await completeTrustedLogin(pending.request, code, pending.password);
              challenge.value = undefined;
              setUser(result.user);
            }}
            onCancel={(expired) => {
              challenge.value = undefined;
              if (expired) setError('登录请求已过期，请重新输入账号密码');
            }}
          />
        ) : (
          <form key={mode} ref={formElement} class="im-form account-entry-form" onSubmit={submit}>
            {mode === 'register' && (
              <label>
                昵称
                <input name="displayName" required maxlength={60} autocomplete="nickname" />
              </label>
            )}
            <label class={mode === 'recovery' ? 'recovery-account-field' : undefined}>
              {mode === 'recovery' ? (
                <Icon name="user" size={21} />
              ) : mode === 'register' ? (
                '用户名'
              ) : (
                'UID 或用户名'
              )}
              <input
                aria-label={mode === 'recovery' ? 'UID 或用户名' : undefined}
                key={mode}
                name={mode === 'register' ? 'username' : 'identifier'}
                required
                minlength={mode === 'register' ? 3 : undefined}
                maxlength={mode === 'register' ? 32 : undefined}
                pattern={mode === 'register' ? '(?=.*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,31}' : undefined}
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
                placeholder={
                  mode === 'register' ? '例如 chatuser' : mode === 'recovery' ? 'UID 或用户名' : undefined
                }
              />
            </label>
            {mode === 'register' && (
              <small>3–32 位字母、数字、横线或下划线，至少一个字母。注册后自动获得永久 UID。</small>
            )}
            {mode === 'recovery' ? (
              <div class="recovery-code-field">
                <div class="recovery-code-field-head">
                  <label for={recoveryId}>账号恢复码</label>
                  <button
                    type="button"
                    class="text-button"
                    aria-label={recoveryVisible.value ? '隐藏恢复码' : '显示恢复码'}
                    aria-pressed={recoveryVisible.value}
                    disabled={busy}
                    onClick={() => {
                      recoveryVisible.value = !recoveryVisible.value;
                      void nextTick(() => recoveryInput.value?.focus({ preventScroll: true }));
                    }}
                  >
                    {recoveryVisible.value ? '隐藏' : '显示'}
                  </button>
                </div>
                {recoveryVisible.value ? (
                  <textarea
                    key="visible-recovery"
                    ref={recoveryInput}
                    id={recoveryId}
                    name="password"
                    rows={3}
                    required
                    minlength={10}
                    maxlength={1024}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    placeholder="输入保存的恢复码，可粘贴多行内容"
                    value={recoveryCode.value}
                    disabled={busy}
                    onInput={(event) =>
                      (recoveryCode.value = (event.currentTarget as HTMLTextAreaElement).value)
                    }
                  />
                ) : (
                  <input
                    key="hidden-recovery"
                    ref={recoveryInput}
                    id={recoveryId}
                    name="password"
                    type="password"
                    required
                    minlength={10}
                    maxlength={1024}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    placeholder="输入保存的恢复码，可粘贴多行内容"
                    value={recoveryCode.value}
                    disabled={busy}
                    onInput={(event) =>
                      (recoveryCode.value = (event.currentTarget as HTMLInputElement).value)
                    }
                  />
                )}
              </div>
            ) : (
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  required
                  minlength={10}
                  maxlength={128}
                  autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
                  placeholder={mode === 'register' ? '至少 10 位' : undefined}
                />
              </label>
            )}
            {mode === 'register' && requiresCode && (
              <label>
                注册码
                <input name="registrationCode" required autocomplete="off" />
              </label>
            )}
            <ErrorNotice text={error} />
            <button
              class="primary"
              disabled={busy}
              aria-label={!busy && mode === 'login' ? '登录账户' : undefined}
            >
              {busy
                ? '请稍候…'
                : mode === 'register'
                  ? '创建账户'
                  : mode === 'recovery'
                    ? '验证恢复码'
                    : '登录'}
            </button>
            {mode === 'recovery' && (
              <p class="recovery-preserves-data">
                <Icon name="shield" size={21} />
                <span>验证后设置新密码，原有加密聊天与电脑授权继续保留。</span>
              </p>
            )}
          </form>
        )}
        {mode === 'recovery' && (
          <div class="recovery-other-options">
            <button type="button" class="secondary" disabled={busy} onClick={() => switchMode('login')}>
              <Icon name="back" size={20} />
              返回登录
            </button>
            <div class="recovery-missing-code">
              <p>
                <Icon name="info" size={20} />
                没有恢复码？请使用仍已登录的设备。
              </p>
              <button type="button" class="secondary" disabled={busy} onClick={() => switchMode('qr')}>
                <Icon name="monitor" size={20} />
                查看其他登录方式
              </button>
            </div>
            <ol class="recovery-next-steps" aria-label="恢复账号后续步骤">
              <li class="recovery-next-label">后续步骤</li>
              <li>
                <span>1</span>新密码
              </li>
              <li>
                <span>2</span>保存新恢复码
              </li>
            </ol>
          </div>
        )}
        {!pending && mode !== 'recovery' && (
          <nav class="account-entry-links" aria-label="其他账号操作">
            {signingIn ? (
              <>
                {registrationEnabled.value === true && (
                  <button
                    type="button"
                    class="text-button"
                    disabled={busy}
                    onClick={() => switchMode('register')}
                  >
                    创建账号
                  </button>
                )}
                <button
                  type="button"
                  class="text-button"
                  disabled={busy}
                  onClick={() => switchMode('recovery')}
                >
                  恢复账号
                </button>
              </>
            ) : (
              <button type="button" class="text-button" disabled={busy} onClick={() => switchMode('login')}>
                返回登录
              </button>
            )}
          </nav>
        )}
        {signingIn && !pending && registrationEnabled.value === false && (
          <p class="login-registration-note" role="status">
            本站暂不开放注册
          </p>
        )}
        {signingIn && !pending && artworkSource.value && (
          <img
            class="signed-out-artwork"
            src={artworkSource.value}
            width={720}
            height={480}
            alt=""
            loading="lazy"
            decoding="async"
            fetchpriority="low"
            referrerpolicy="no-referrer"
            onError={() => {
              if (artworkSource.value !== loginArtwork) artworkSource.value = loginArtwork;
            }}
          />
        )}
      </section>
    );
  };
});
