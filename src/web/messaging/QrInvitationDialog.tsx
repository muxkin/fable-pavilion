import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { Dialog } from '../shell/Dialog';
import { Icon } from '../Icon';
import {
  cancelQrInvitation,
  createQrInvitation,
  qrInvitationStatus,
  qrInvitationUrl,
  type QrApprovalRequest,
} from '../trusted-login';
import { tsxComponent } from '../tsx-component';
import { Notice, errorText } from './ui';
import { defaultTrustedDeviceName, LoginExpiry, LoginQrSteps } from './TrustedLogin';
import './login-entry.css';

export const QrInvitationDialog = tsxComponent(function QrInvitationDialog(props: {
  onClaim: (request: QrApprovalRequest, invitationId: string) => void;
  onClose: () => void;
  onScan?: () => void;
}) {
  const qr = shallowRef<{ image: string; expiresAt: number }>();
  const creating = shallowRef(false);
  const cancelling = shallowRef(false);
  const status = shallowRef('');
  const error = shallowRef('');
  let pollRequest: AbortController | undefined;
  let invitationId: string | undefined;
  let pollTimer: number | undefined;
  let expiryTimer: number | undefined;
  let generation = 0;
  let disposed = false;

  function stopPolling() {
    pollRequest?.abort();
    pollRequest = undefined;
    window.clearTimeout(pollTimer);
    window.clearTimeout(expiryTimer);
    qr.value = undefined;
  }

  function expire(id: string) {
    invitationId = undefined;
    stopPolling();
    status.value = '二维码已过期，请刷新后重试';
    void cancelQrInvitation(id).catch(() => {});
  }

  onScopeDispose(() => {
    disposed = true;
    generation++;
    stopPolling();
    if (invitationId && !cancelling.value) void cancelQrInvitation(invitationId).catch(() => {});
  });

  async function close(next = props.onClose) {
    if (cancelling.value) return;
    generation++;
    stopPolling();
    const id = invitationId;
    if (!id) {
      next();
      return;
    }
    error.value = '';
    cancelling.value = true;
    try {
      await cancelQrInvitation(id);
      invitationId = undefined;
      if (!disposed) next();
    } catch (cause) {
      if (!disposed) error.value = errorText(cause);
    } finally {
      cancelling.value = false;
    }
  }

  async function poll(id: string, request: AbortController) {
    try {
      const result = await qrInvitationStatus(id, request.signal);
      if (request.signal.aborted) return;
      if (result.state === 'waiting') {
        pollTimer = window.setTimeout(() => void poll(id, request), 2000);
        return;
      }
      invitationId = undefined;
      stopPolling();
      if (result.state === 'claimed') props.onClaim(result.request, id);
      else if (result.state === 'expired') status.value = '二维码已过期，请刷新后重试';
      else if (result.state === 'cancelled') status.value = '这次登录已取消';
      else status.value = '这次登录已处理';
    } catch (cause) {
      if (request.signal.aborted) return;
      stopPolling();
      error.value = errorText(cause);
    }
  }

  async function refresh() {
    if (creating.value || cancelling.value) return;
    const current = ++generation;
    const old = invitationId;
    stopPolling();
    creating.value = true;
    error.value = '';
    status.value = '';
    try {
      if (old) await cancelQrInvitation(old);
      invitationId = undefined;
      if (disposed || current !== generation) return;
      const request = new AbortController();
      pollRequest = request;
      const invite = await createQrInvitation(request.signal);
      if (disposed || current !== generation || request.signal.aborted) {
        void cancelQrInvitation(invite.id).catch(() => {});
        return;
      }
      invitationId = invite.id;
      const { default: QRCode } = await import('qrcode');
      const image = await QRCode.toDataURL(qrInvitationUrl(invite), { width: 320, margin: 4 });
      if (request.signal.aborted) return;
      const remaining = invite.expiresAt - Date.now();
      if (remaining <= 0) {
        expire(invite.id);
        return;
      }
      qr.value = { image, expiresAt: invite.expiresAt };
      expiryTimer = window.setTimeout(() => expire(invite.id), remaining);
      void poll(invite.id, request);
    } catch (cause) {
      if (!disposed && current === generation) error.value = errorText(cause);
    } finally {
      if (!disposed && current === generation) creating.value = false;
    }
  }
  onMounted(() => void refresh());

  return ({ onScan }) => (
    <Dialog title="让另一台设备登录" className="login-invitation-dialog" onClose={() => void close()}>
      {() => (
        <div class="im-form im-trusted-qr login-invitation-content">
          <LoginQrSteps />
          <div class="login-qr-instructions">
            <h3>
              在新手机打开子虚亭
              <br />
              点击扫码登录
            </h3>
            <p>用新手机扫描这里的二维码。</p>
          </div>
          <div class="login-qr-code" data-loading={!qr.value}>
            {qr.value ? (
              <img src={qr.value.image} width={264} height={264} alt="新设备登录邀请二维码" />
            ) : (
              <p role="status">{creating.value ? '正在生成二维码…' : status.value || '二维码暂不可用'}</p>
            )}
          </div>
          <p class="login-current-device">
            当前设备：<strong>{defaultTrustedDeviceName}</strong>
          </p>
          <div class="login-qr-expiry">
            <span>
              <Icon name="clock" size={18} />
              {qr.value ? <LoginExpiry expiresAt={qr.value.expiresAt} /> : '请刷新二维码'}
            </span>
            <button
              type="button"
              disabled={creating.value || cancelling.value}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" size={18} />
              刷新二维码
            </button>
          </div>
          <div class="login-invitation-waiting" role="status">
            <h4>
              <span class="login-waiting-indicator" aria-hidden="true" />
              {qr.value ? '等待扫描' : creating.value ? '正在准备' : '等待刷新'}
            </h4>
            <p>扫描后，还需在本机核对代码并确认登录。</p>
          </div>
          <Notice text={error.value} />
          {onScan && (
            <button
              type="button"
              class="secondary login-switch-direction"
              disabled={creating.value || cancelling.value}
              onClick={() => void close(onScan)}
            >
              <Icon name="camera" size={21} />
              改为扫描新设备
            </button>
          )}
          <button
            type="button"
            class="text-button login-invitation-cancel"
            disabled={cancelling.value}
            onClick={() => void close()}
          >
            {cancelling.value ? '正在取消…' : '取消登录'}
          </button>
        </div>
      )}
    </Dialog>
  );
});
