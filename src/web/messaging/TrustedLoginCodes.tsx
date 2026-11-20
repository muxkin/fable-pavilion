import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { Icon } from '../Icon';
import { refreshCurrentLoginCode, showCurrentLoginCode } from '../trusted-login';
import { tsxComponent } from '../tsx-component';
import { Notice, errorText } from './ui';

type DisplayCode = { code: string; expiresAt: number };
export const TrustedLoginCodes = tsxComponent(function TrustedLoginCodes(props: {
  initiallyVisible?: boolean;
}) {
  const displaying = shallowRef(false);
  const code = shallowRef<DisplayCode>();
  const error = shallowRef('');
  const now = shallowRef(Date.now());
  let display: AbortController | undefined;
  let codeTimer: number | undefined;
  let tick: number | undefined;
  function hideCode() {
    display?.abort();
    display = undefined;
    window.clearTimeout(codeTimer);
    window.clearInterval(tick);
    code.value = undefined;
    displaying.value = false;
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden') hideCode();
  }
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility);
    if (props.initiallyVisible) void toggleCode();
  });
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    hideCode();
  });
  function scheduleCode(value: DisplayCode, signal: AbortSignal, retryStale = true) {
    now.value = Date.now();
    const remaining = value.expiresAt - now.value;
    if (remaining <= 0 && !retryStale) throw new Error('动态码已过期，请重新查看');
    code.value = remaining > 0 ? value : undefined;
    codeTimer = window.setTimeout(
      async () => {
        code.value = undefined;
        try {
          const next = await refreshCurrentLoginCode(undefined, signal);
          if (!signal.aborted) scheduleCode(next, signal, remaining > 0);
        } catch (cause) {
          if (signal.aborted) return;
          hideCode();
          error.value = errorText(cause);
        }
      },
      Math.max(100, remaining > 0 ? remaining : 500),
    );
  }
  async function toggleCode() {
    if (displaying.value) return hideCode();
    const request = new AbortController();
    display = request;
    displaying.value = true;
    error.value = '';
    try {
      const result = await showCurrentLoginCode(request.signal);
      if (request.signal.aborted) return;
      scheduleCode(result, request.signal);
      tick = window.setInterval(() => {
        now.value = Date.now();
      }, 1000);
    } catch (cause) {
      if (request.signal.aborted) return;
      hideCode();
      error.value = errorText(cause);
    }
  }
  return () => {
    const remaining = code.value ? Math.max(0, Math.ceil((code.value.expiresAt - now.value) / 1000)) : 0;
    return (
      <section class="login-code-panel" aria-label="登录动态码">
        <div class="login-code-heading">
          <h3>登录动态码</h3>
          <span class="login-code-default">默认开启</span>
          <button
            type="button"
            class="login-code-toggle"
            aria-expanded={displaying.value}
            onClick={() => void toggleCode()}
          >
            <Icon name={displaying.value ? 'eyeOff' : 'shield'} size={16} />
            {displaying.value ? '隐藏动态码' : '查看动态码'}
          </button>
        </div>
        {displaying.value ? (
          <div class="login-code-display">
            <strong class="login-code-digits" dir="ltr" translate="no" aria-live="polite">
              {code.value ? code.value.code.replace(/^(\d{3})(\d{3})$/, '$1 $2') : '正在读取…'}
            </strong>
            {code.value && (
              <div class="login-code-countdown" role="timer" aria-label={`${remaining} 秒后更新`}>
                <span class="login-code-ring" aria-hidden="true">
                  <svg viewBox="0 0 40 40">
                    <circle class="ring-track" cx="20" cy="20" r="17" />
                    <circle
                      class="ring-progress"
                      cx="20"
                      cy="20"
                      r="17"
                      pathLength="100"
                      stroke-dasharray={`${(remaining / 30) * 100} 100`}
                    />
                  </svg>
                  <b>{remaining}</b>
                </span>
                <span>秒后更新</span>
              </div>
            )}
          </div>
        ) : (
          <p class="login-code-hint">在新设备使用密码登录时，输入这里的 6 位动态码。</p>
        )}
        <Notice text={error.value} />
      </section>
    );
  };
});
