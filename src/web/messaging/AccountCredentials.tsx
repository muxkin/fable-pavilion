import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { Icon } from '../Icon';
import { rememberAccount } from '../account-session';
import { trustedDevices, verifyTrustedAction, type TrustedDevicesState } from '../trusted-login';
import { messaging } from './context';
import { Notice, errorText, type Navigate } from './ui';
import '../shell/settings-hierarchy.css';

/** AccountClient keeps the existing vault identity and activates the shared recovery-code guard. */
export default tsxComponent(function AccountCredentials(_props: { navigate: Navigate }) {
  const busy = shallowRef(false);
  const error = shallowRef('');
  const notice = shallowRef('');
  const expanded = shallowRef<'password' | 'recovery'>();
  const trusted = shallowRef<TrustedDevicesState | null>(null);
  const form = shallowRef<HTMLFormElement | null>(null);
  const controller = new AbortController();
  onMounted(() => {
    void trustedDevices(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) trusted.value = result;
      })
      .catch(() => {});
  });
  onScopeDispose(() => {
    controller.abort();
    form.value?.reset();
  });

  async function changePassword(event: SubmitEvent) {
    event.preventDefault();
    if (busy.value) return;
    const target = event.currentTarget as HTMLFormElement;
    const data = new FormData(target);
    error.value = '';
    notice.value = '';
    const recovery = expanded.value === 'recovery';
    const deviceOnly =
      trusted.value?.deviceOnly === true ||
      trusted.value?.deviceLoginOnly === true ||
      !messaging.account.vault?.password;
    if (!recovery && data.get('newPassword') !== data.get('confirm')) {
      error.value = '两次新密码不一致';
      return;
    }
    busy.value = true;
    try {
      if (recovery) {
        if (trusted.value?.passkeysHere) {
          const approval = await verifyTrustedAction('recovery-rotate');
          await messaging.account.rotateRecovery({ approval });
        } else if (deviceOnly) {
          await messaging.account.rotateRecovery({ sessionConfirm: true });
        } else {
          await messaging.account.rotateRecovery(String(data.get('currentPassword')));
        }
      } else {
        await messaging.account.changePassword(
          String(data.get('currentPassword')),
          String(data.get('newPassword')),
        );
      }
      await rememberAccount(messaging.account);
      target.reset();
      expanded.value = undefined;
      notice.value = recovery ? '恢复码已更换' : '密码已修改，其他设备已退出登录';
    } catch (cause) {
      error.value = errorText(cause);
    } finally {
      busy.value = false;
    }
  }

  return ({ navigate }) => {
    const deviceOnly =
      trusted.value?.deviceOnly === true ||
      trusted.value?.deviceLoginOnly === true ||
      !messaging.account.vault?.password;
    const passkeysHere = trusted.value?.passkeysHere === true;
    return (
      <div class="settings-hierarchy-content account-credentials-content">
        <div class="security-quiet-actions">
          {!deviceOnly && (
            <button
              type="button"
              aria-expanded={expanded.value === 'password'}
              disabled={busy.value}
              onClick={() => {
                error.value = '';
                expanded.value = expanded.value === 'password' ? undefined : 'password';
              }}
            >
              <Icon name="shield" size={22} />
              <span>修改密码</span>
              <Icon name="chevron" size={16} />
            </button>
          )}
          <button
            type="button"
            aria-expanded={expanded.value === 'recovery'}
            disabled={busy.value}
            onClick={() => {
              error.value = '';
              expanded.value = expanded.value === 'recovery' ? undefined : 'recovery';
            }}
          >
            <Icon name="key" size={22} />
            <span>更换恢复码</span>
            <Icon name="chevron" size={16} />
          </button>
          <button type="button" disabled={busy.value} onClick={() => navigate({ page: 'account-recovery' })}>
            <Icon name="document" size={22} />
            <span>如何找回账号</span>
            <Icon name="chevron" size={16} />
          </button>
        </div>
        {expanded.value && (
          <section class="credentials-section" key={expanded.value}>
            <h2 class="credentials-section-title">
              {expanded.value === 'password' ? '修改密码' : '更换恢复码'}
            </h2>
            <p class="credentials-description">
              {expanded.value === 'password'
                ? '更新后，其他设备会退出登录，旧恢复码会失效。请保存新恢复码。'
                : '生成新恢复码后，旧码会立即失效。请保存新码。'}
            </p>
            <form ref={form} class="im-form credentials-password-form" onSubmit={changePassword}>
              {(expanded.value === 'password' || (!deviceOnly && !passkeysHere)) && (
                <label>
                  当前密码
                  <input
                    name="currentPassword"
                    type="password"
                    autocomplete="current-password"
                    required
                    disabled={busy.value}
                  />
                </label>
              )}
              {expanded.value === 'password' && (
                <>
                  <label>
                    新密码
                    <input
                      name="newPassword"
                      type="password"
                      autocomplete="new-password"
                      minlength={10}
                      maxlength={128}
                      required
                      disabled={busy.value}
                    />
                  </label>
                  <label>
                    确认新密码
                    <input
                      name="confirm"
                      type="password"
                      autocomplete="new-password"
                      minlength={10}
                      maxlength={128}
                      required
                      disabled={busy.value}
                    />
                  </label>
                </>
              )}
              <Notice text={error.value} />
              <button class="primary" disabled={busy.value}>
                {busy.value
                  ? '正在更新…'
                  : expanded.value === 'password'
                    ? '更新密码'
                    : passkeysHere
                      ? '使用通行密钥生成新恢复码'
                      : '生成新恢复码'}
              </button>
            </form>
          </section>
        )}
        {notice.value && (
          <p class="settings-inline-notice" role="status">
            {notice.value}
          </p>
        )}
      </div>
    );
  };
});
