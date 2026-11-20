import { nextTick, onMounted, onScopeDispose, shallowRef } from 'vue';
import type { AuthenticatorSetupGrant } from '../../client/account';
import { Icon } from '../Icon';
import { pasteLoginCode } from '../login-code-input';
import { PageHeader } from '../shell/PageHeader';
import { tsxComponent } from '../tsx-component';
import { messaging } from './context';
import { RecoveryCode } from './RecoveryCode';
import { Notice, errorText } from './ui';
import './security-onboarding.css';
import { backupKnownAdapters } from '../adapter-security-backup';

type Setup = { secret: string; uri: string; expiresAt: number };
export const SecurityOnboarding = tsxComponent(function SecurityOnboarding(props: {
  recoveryCode: string;
  setup?: AuthenticatorSetupGrant;
  recovered?: boolean;
  onComplete: () => void;
}) {
  const stage = shallowRef<'backup' | 'authenticator'>('backup');
  const setup = shallowRef<Setup>();
  const image = shallowRef('');
  const loading = shallowRef(false);
  const working = shallowRef(false);
  const loaded = shallowRef(false);
  const error = shallowRef('');
  const now = shallowRef(Date.now());
  const heading = shallowRef<HTMLElement | null>(null);
  let request: AbortController | undefined;
  let timer: number | undefined;
  let disposed = false;
  const expired = () => !!props.setup && now.value >= props.setup.expiresAt;
  function conceal() {
    setup.value = undefined;
    image.value = '';
  }
  function hidden() {
    if (document.visibilityState === 'hidden') conceal();
  }
  onMounted(() => {
    document.addEventListener('visibilitychange', hidden);
    timer = window.setInterval(() => {
      now.value = Date.now();
      if (expired()) conceal();
    }, 1000);
  });
  onScopeDispose(() => {
    disposed = true;
    request?.abort();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', hidden);
    conceal();
  });
  async function showSetup() {
    if (!props.setup || loading.value || expired()) return;
    request?.abort();
    const attempt = new AbortController();
    request = attempt;
    loading.value = true;
    error.value = '';
    try {
      const result = await messaging.request<Setup>(
        '/crypto/authenticator/setup',
        'POST',
        { grant: props.setup.grant, name: '身份验证器' },
        attempt.signal,
      );
      const { default: QRCode } = await import('qrcode');
      const qr = await QRCode.toDataURL(result.uri, { width: 264, margin: 4 });
      if (attempt.signal.aborted || disposed || expired() || document.visibilityState === 'hidden') return;
      setup.value = result;
      image.value = qr;
      loaded.value = true;
    } catch (cause) {
      if (!attempt.signal.aborted) error.value = errorText(cause);
    } finally {
      if (!attempt.signal.aborted) loading.value = false;
    }
  }
  async function continueBackup() {
    if (working.value) return;
    void backupKnownAdapters(
      messaging.account,
      messaging.raw.bind(messaging),
      props.setup,
      props.recoveryCode,
    ).catch(() => {});
    if (disposed) return;
    if (!props.setup) return props.onComplete();
    stage.value = 'authenticator';
    await nextTick();
    heading.value?.focus();
  }
  async function skip() {
    if (working.value) return;
    working.value = true;
    request?.abort();
    conceal();
    try {
      if (props.setup)
        await messaging.request('/crypto/authenticator/cancel', 'POST', { grant: props.setup.grant });
    } catch {
      /* The short-lived setup capability also expires server-side. */
    } finally {
      if (!disposed) props.onComplete();
    }
  }
  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    if (!props.setup || !loaded.value || working.value || expired()) return;
    const form = event.currentTarget as HTMLFormElement;
    const code = String(new FormData(form).get('code')).replace(/\s/g, '');
    working.value = true;
    error.value = '';
    try {
      await messaging.request('/crypto/authenticator/confirm', 'POST', { grant: props.setup.grant, code });
      if (disposed) return;
      conceal();
      form.reset();
      props.onComplete();
    } catch (cause) {
      error.value = errorText(cause);
      form.reset();
    } finally {
      if (!disposed) working.value = false;
    }
  }
  return ({ recoveryCode }) => {
    const seconds = props.setup ? Math.max(0, Math.ceil((props.setup.expiresAt - now.value) / 1000)) : 0;
    const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    return (
      <main class="module-page pavilion-flow security-onboarding">
        <PageHeader
          title="完成安全设置"
          back={
            stage.value === 'authenticator'
              ? () => {
                  conceal();
                  stage.value = 'backup';
                }
              : undefined
          }
        />
        <section class="pavilion-flow-content security-onboarding-content">
          {props.setup && (
            <ol class="security-setup-steps" aria-label="安全设置步骤">
              <li aria-current={stage.value === 'backup' ? 'step' : undefined}>
                <span>{stage.value === 'backup' ? '1' : <Icon name="check" size={16} />}</span>保存恢复码
              </li>
              <li aria-current={stage.value === 'authenticator' ? 'step' : undefined}>
                <span>2</span>添加验证器
              </li>
            </ol>
          )}
          <h2 ref={heading} tabindex={-1} class="pavilion-flow-title">
            {stage.value === 'backup' ? '保存账号恢复码' : '添加身份验证器'}
          </h2>
          {stage.value === 'backup' ? (
            <>
              <p class="pavilion-flow-description">无法使用动态码或丢失所有设备时，可用恢复码找回账号。</p>
              {props.recovered && (
                <p class="security-recovery-renewed">原来的恢复码和动态码已失效，请保存新的恢复码。</p>
              )}
              <RecoveryCode
                code={recoveryCode}
                busy={working.value}
                onContinue={() => void continueBackup()}
              />
              <p class="security-setup-footnote">恢复后将设置新密码和新恢复码。</p>
            </>
          ) : (
            <>
              <p class="pavilion-flow-description">内置动态码已开启，也可添加到你常用的验证器。</p>
              <div class="authenticator-qr-region">
                {image.value ? (
                  <img src={image.value} alt="身份验证器设置二维码" width={232} height={232} />
                ) : (
                  <div class="authenticator-concealed" role="status">
                    <Icon name="shield" size={30} />
                    <span>{expired() ? '本次设置已到期' : loading.value ? '正在生成设置二维码…' : ''}</span>
                    {!loading.value && !expired() && (
                      <button class="secondary" onClick={() => void showSetup()}>
                        显示设置二维码
                      </button>
                    )}
                  </div>
                )}
              </div>
              <p class="authenticator-compatibility">
                支持 Google Authenticator、Microsoft Authenticator 等标准 TOTP 验证器。
              </p>
              {setup.value && (
                <details class="authenticator-manual">
                  <summary>
                    <Icon name="key" size={18} />
                    无法扫码？手动输入设置密钥
                  </summary>
                  <code translate="no" dir="ltr">
                    {setup.value.secret}
                  </code>
                  <button
                    class="secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(setup.value!.secret);
                      } catch {
                        error.value = '请选中设置密钥手动复制。';
                      }
                    }}
                  >
                    <Icon name="copy" size={16} />
                    复制设置密钥
                  </button>
                </details>
              )}
              <form class="im-form authenticator-confirm" onSubmit={confirm}>
                <label>
                  验证器中的 6 位动态码
                  <input
                    name="code"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    onPaste={pasteLoginCode}
                    pattern="[0-9]{6}"
                    maxlength={6}
                    minlength={6}
                    required
                    aria-describedby="authenticator-time-left"
                    disabled={working.value || expired()}
                  />
                </label>
                <Notice text={error.value} />
                <button class="primary" disabled={!loaded.value || working.value || expired()}>
                  {working.value ? '正在验证…' : '验证并完成'}
                </button>
                <button type="button" class="secondary" disabled={working.value} onClick={() => void skip()}>
                  暂时跳过，使用内置动态码
                </button>
              </form>
              <p class="security-setup-footnote" id="authenticator-time-left" role="timer">
                {expired() ? '可继续使用内置动态码，稍后再添加验证器。' : `${countdown} 后本次设置失效。`}
              </p>
              <p class="security-setup-footnote">稍后仍可在「我的 → 登录与安全」查看内置动态码。</p>
            </>
          )}
        </section>
      </main>
    );
  };
});
