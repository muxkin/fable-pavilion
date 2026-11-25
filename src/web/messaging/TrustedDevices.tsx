import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { deviceLoginMatchCode } from '../../shared/trusted-device-crypto';
import { QrScanner } from '../QrScanner';
import { Icon } from '../Icon';
import type { AppRoute } from '../shell/routes';
import './login-security.css';
import { Dialog } from '../shell/Dialog';
import { tsxComponent } from '../tsx-component';
import {
  approveQrLogin,
  cancelQrInvitation,
  enrollTrustedDevice,
  loadQrRequest,
  parseQrLoginUrl,
  revokeTrustedDevice,
  trustedDevices,
  trustedLoginEventLabels,
  type QrApprovalRequest,
  type TrustedDevicesState,
} from '../trusted-login';
import { QrInvitationDialog } from './QrInvitationDialog';
import { defaultTrustedDeviceName, loginMatchCode } from './TrustedLogin';
import { TrustedLoginCodes } from './TrustedLoginCodes';
import { Confirm, Notice, errorText, time } from './ui';
import { deviceLoginRequired } from './context';
import { AdminAuthApproval, parseAdminAuthUrl, type AdminAuthParams } from './AdminAuthApproval';

export const TrustedDevices = tsxComponent(function TrustedDevices(props: {
  accountId: string;
  view?: 'overview' | 'devices';
  action?: 'code' | 'scan' | 'invite';
  navigate?: (route: AppRoute) => void;
}) {
  const state = shallowRef<TrustedDevicesState>();
  const refreshing = shallowRef(false);
  const enrollOpen = shallowRef(false);
  const enrolling = shallowRef(false);
  const revoke = shallowRef<TrustedDevicesState['devices'][number]>();
  const inviteOpen = shallowRef(false);
  const scannerOpen = shallowRef(false);
  const adminAuth = shallowRef<AdminAuthParams | null>(null);
  const approval = shallowRef<QrApprovalRequest>();
  const checkingQr = shallowRef(false);
  const matchCode = shallowRef('');
  const approving = shallowRef(false);
  const error = shallowRef('');
  const status = shallowRef('');
  let approvalTimer: number | undefined;
  let approvalInvitationId: string | undefined;
  let refreshRequest: AbortController | undefined;
  let disposed = false;

  onScopeDispose(() => {
    disposed = true;
    refreshRequest?.abort();
    window.clearTimeout(approvalTimer);
    if (approvalInvitationId) void cancelQrInvitation(approvalInvitationId).catch(() => {});
  });

  async function reload() {
    if (disposed) return;
    refreshRequest?.abort();
    const request = new AbortController();
    refreshRequest = request;
    refreshing.value = true;
    error.value = '';
    try {
      const result = await trustedDevices(request.signal);
      if (!request.signal.aborted) state.value = result;
    } catch (cause) {
      if (!request.signal.aborted) error.value = errorText(cause);
    } finally {
      if (!request.signal.aborted) refreshing.value = false;
    }
  }

  function closeApproval(approved = false) {
    window.clearTimeout(approvalTimer);
    approval.value = undefined;
    matchCode.value = '';
    const invitationId = approvalInvitationId;
    approvalInvitationId = undefined;
    if (invitationId && !approved)
      void cancelQrInvitation(invitationId).catch((cause) => {
        if (!disposed) status.value = errorText(cause);
      });
  }

  function showApproval(request: QrApprovalRequest) {
    if (deviceLoginRequired && !request.deviceBound) request = { ...request, deviceBound: true };
    const timeLeft = request.expiresAt - Date.now();
    if (timeLeft <= 0) throw new Error('扫码登录请求已过期');
    approval.value = request;
    if (request.deviceBound) {
      void deviceLoginMatchCode(request.id, request.publicKey)
        .then((code) => {
          if (approval.value === request) matchCode.value = code;
        })
        .catch((cause) => {
          if (approval.value === request) error.value = errorText(cause);
        });
    } else matchCode.value = loginMatchCode(request.id);
    approvalTimer = window.setTimeout(() => {
      closeApproval();
      status.value = '扫码登录请求已过期';
    }, timeLeft);
  }

  function receiveInvitationClaim(request: QrApprovalRequest, invitationId: string) {
    inviteOpen.value = false;
    approvalInvitationId = invitationId;
    status.value = '';
    error.value = '';
    try {
      showApproval(request);
    } catch (cause) {
      closeApproval();
      status.value = errorText(cause);
    }
  }

  async function openApproval(id: string, fingerprint: string) {
    if (checkingQr.value || inviteOpen.value || approval.value || approving.value || disposed) return;
    checkingQr.value = true;
    status.value = '';
    error.value = '';
    try {
      const request = await loadQrRequest(id, fingerprint);
      if (disposed) return;
      showApproval(request);
    } catch (cause) {
      if (!disposed) status.value = errorText(cause);
    } finally {
      checkingQr.value = false;
    }
  }

  function readQrLogin(text: string) {
    const adminReq = parseAdminAuthUrl(text);
    if (adminReq) {
      scannerOpen.value = false;
      adminAuth.value = adminReq;
      return;
    }
    const { id, fingerprint } = parseQrLoginUrl(text);
    void openApproval(id, fingerprint);
  }

  onMounted(() => {
    if (props.action === 'scan') scannerOpen.value = true;
    if (props.action === 'invite') inviteOpen.value = true;
    void reload();
    const url = new URL(location.href);
    if (!url.searchParams.has('login-qr') && !url.searchParams.has('login-key')) return;
    const link = url.href;
    url.searchParams.set('page', 'login-security');
    url.searchParams.delete('login-qr');
    url.searchParams.delete('login-key');
    history.replaceState(history.state, '', url);
    try {
      readQrLogin(link);
    } catch (cause) {
      status.value = errorText(cause);
    }
  });

  return ({ accountId, view = 'devices', action, navigate }) => {
    async function enroll(password?: string, recoveryCode?: string) {
      const current = state.value;
      if (enrolling.value || !current) return;
      enrolling.value = true;
      error.value = '';
      status.value = '';
      try {
        await enrollTrustedDevice(
          accountId,
          password,
          defaultTrustedDeviceName,
          !current.recentlyVerified && !recoveryCode && Boolean(current.hasCredentials),
          recoveryCode,
        );
        enrollOpen.value = false;
        status.value = '通行密钥已创建';
        await reload();
      } catch (cause) {
        const message = errorText(cause);
        await reload();
        error.value = message;
      } finally {
        enrolling.value = false;
      }
    }

    async function approve(request: QrApprovalRequest) {
      if (
        !matchCode.value ||
        approving.value ||
        approval.value?.id !== request.id ||
        request.expiresAt <= Date.now()
      )
        return;
      approving.value = true;
      error.value = '';
      try {
        await approveQrLogin(request);
        closeApproval(true);
        status.value = '已批准新设备登录';
      } catch (cause) {
        error.value = errorText(cause);
      } finally {
        approving.value = false;
      }
    }

    const current = state.value;
    const request = current?.available ? approval.value : undefined;
    const overview = view === 'overview';
    return (
      <section
        class={`im-trusted-settings ${overview ? 'security-overview' : 'security-devices'}`}
        aria-label={overview ? '登录与安全' : '通行密钥'}
      >
        {checkingQr.value && (
          <p class="im-help" role="status">
            正在读取登录请求…
          </p>
        )}
        {current?.available && overview && (
          <>
            {current.totpEnabled && (
              <section class="security-section" aria-labelledby="security-protection-title">
                <h2 class="security-section-title" id="security-protection-title">
                  登录保护
                </h2>
                <TrustedLoginCodes initiallyVisible={action === 'code'} />
              </section>
            )}
            <section class="security-section security-login-actions" aria-labelledby="security-other-devices">
              <h2 class="security-section-title" id="security-other-devices">
                设备登录
              </h2>
              <button
                class="security-action-row"
                onClick={() => {
                  scannerOpen.value = false;
                  inviteOpen.value = true;
                }}
              >
                <Icon name="qr" size={25} />
                <span>
                  <strong>出示登录二维码</strong>
                  <small>让另一台设备扫描。</small>
                </span>
                <Icon name="chevron" size={18} />
              </button>
              <button
                class="security-action-row"
                onClick={() => {
                  inviteOpen.value = false;
                  scannerOpen.value = true;
                }}
              >
                <Icon name="camera" size={25} />
                <span>
                  <strong>扫描新设备二维码</strong>
                  <small>批准另一台设备登录。</small>
                </span>
                <Icon name="chevron" size={18} />
              </button>
            </section>
            <section class="security-section" aria-labelledby="security-management-title">
              <h2 class="security-section-title" id="security-management-title">
                安全管理
              </h2>
              <div class="security-quiet-actions">
                <button onClick={() => navigate?.({ page: 'login-devices' })}>
                  <Icon name="monitor" size={23} />
                  <span>登录设备</span>
                  <Icon name="chevron" size={18} />
                </button>
                {(current.totpAvailable || (current.authenticators?.length ?? 0) > 0) && (
                  <button onClick={() => navigate?.({ page: 'authenticators' })}>
                    <Icon name="key" size={23} />
                    <span>第三方验证器</span>
                    <small>
                      {current.authenticators?.length ? `已添加 ${current.authenticators.length} 个` : '未添加'}
                    </small>
                    <Icon name="chevron" size={18} />
                  </button>
                )}
                <button onClick={() => navigate?.({ page: 'account-credentials' })}>
                  <Icon name="key" size={23} />
                  <span>{current.deviceOnly ? '恢复码' : '密码与恢复码'}</span>
                  <Icon name="chevron" size={18} />
                </button>
                <button onClick={() => navigate?.({ page: 'trusted-devices' })}>
                  <Icon name="shield" size={23} />
                  <span>通行密钥</span>
                  <small>{current.passkeysHere ? '本设备已启用' : current.hasCredentials ? '未在本设备启用' : '未添加'}</small>
                  <Icon name="chevron" size={18} />
                </button>
              </div>
            </section>
          </>
        )}
        {current?.available && !overview && (
          <>
            <p class="im-help">用指纹、面容或设备 PIN 确认安全设置。</p>
            {current.devices.length > 0 && (
              <ul class="im-trusted-list" aria-label="已创建的通行密钥">
                {current.devices.map((device) => (
                  <li key={device.id}>
                    <div>
                      <strong>{device.name}</strong>
                      <small>添加于 {time(device.createdAt)}</small>
                      <small>
                        {device.deviceType === 'multiDevice' ? '可同步通行密钥' : '单设备通行密钥'}
                      </small>
                    </div>
                    <button class="secondary" onClick={() => (revoke.value = device)}>
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(current.passkeyAvailable ?? current.available) && (
              <>
                <button
                  class="secondary im-trusted-enroll"
                  aria-expanded={enrollOpen.value}
                  disabled={enrolling.value}
                  onClick={() => {
                    if (
                      current.recentlyVerified ||
                      current.passkeysHere ||
                      (current.deviceOnly && !current.hasCredentials)
                    )
                      void enroll();
                    else enrollOpen.value = !enrollOpen.value;
                  }}
                >
                  {enrolling.value ? '正在验证…' : enrollOpen.value ? '取消' : '创建通行密钥'}
                </button>
                {enrollOpen.value && (
                  <form
                    class="im-form im-trusted-enroll"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget as HTMLFormElement;
                      const data = new FormData(form);
                      form.reset();
                      if (current.deviceOnly) void enroll(undefined, String(data.get('recoveryCode') ?? '').trim());
                      else void enroll(String(data.get('password') ?? ''));
                    }}
                  >
                    {current.deviceOnly ? (
                      <label>
                        账号恢复码
                        <input name="recoveryCode" type="password" autocomplete="off" required />
                      </label>
                    ) : (
                      <label>
                        当前密码
                        <input name="password" type="password" autocomplete="current-password" required />
                      </label>
                    )}
                    <button class="primary" disabled={enrolling.value}>
                      继续
                    </button>
                  </form>
                )}
              </>
            )}
            {!current.passkeyAvailable && <p class="im-help">当前服务地址暂不支持通行密钥。</p>}
          </>
        )}
        {inviteOpen.value && current?.available && (
          <QrInvitationDialog
            onClaim={receiveInvitationClaim}
            onClose={() => {
              inviteOpen.value = false;
            }}
            onScan={() => {
              inviteOpen.value = false;
              scannerOpen.value = true;
            }}
          />
        )}
        {scannerOpen.value && current?.available && (
          <Dialog
            title="扫描新设备二维码"
            onClose={() => {
              scannerOpen.value = false;
            }}
          >
            {() => (
              <div class="security-scan-content">
                <p>在新设备点击「出示本机登录码」。扫描后，在这台设备确认登录。</p>
                <QrScanner
                  cameraAction="开启相机扫描"
                  cameraLabel="登录扫码相机"
                  imageAction="相册导入"
                  imageLabel="导入登录二维码图片"
                  actionIcons
                  onScan={(text) => {
                    readQrLogin(text);
                    scannerOpen.value = false;
                  }}
                />
              </div>
            )}
          </Dialog>
        )}
        {!overview && !!current?.events.length && (
          <details class="im-trusted-requests">
            <summary>最近安全活动</summary>
            <ul class="im-trusted-list" aria-label="账号安全活动">
              {current.events.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{trustedLoginEventLabels[event.kind]}</strong>
                    <small>{event.name}</small>
                    <small>{time(event.createdAt)}</small>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
        {!current &&
          (refreshing.value ? (
            <p class="im-help" role="status">
              正在读取登录设置…
            </p>
          ) : (
            <button class="secondary" onClick={() => void reload()}>
              重新读取
            </button>
          ))}
        {!request && <Notice text={error.value} />}
        <p class="im-help" role="status">
          {status.value}
        </p>
        {request && (
          <Dialog
            title="确认新设备登录"
            onClose={() => {
              if (!approving.value) closeApproval();
            }}
          >
            {() => (
              <div class="im-form im-trusted-approval">
                <p>
                  允许 <strong>{request.name}</strong> 使用当前账号登录？
                </p>
                <div class="login-qr-waiting">
                  <p class="login-match-label">核对两台设备上的代码</p>
                  <strong class="im-trusted-match" translate="no">
                    {matchCode.value || '…'}
                  </strong>
                </div>
                <Notice text={error.value} />
                <div class="im-dialog-actions">
                  <button class="secondary" disabled={approving.value} onClick={() => closeApproval()}>
                    取消
                  </button>
                  <button
                    class="primary"
                    disabled={!matchCode.value || approving.value}
                    onClick={() => void approve(request)}
                  >
                    {approving.value ? '正在确认…' : '代码一致，确认登录'}
                  </button>
                </div>
              </div>
            )}
          </Dialog>
        )}
        {adminAuth.value && (
          <AdminAuthApproval
            key={adminAuth.value.id}
            request={adminAuth.value}
            onClose={() => (adminAuth.value = null)}
          />
        )}
        {revoke.value && (
          <Confirm
            title="移除通行密钥"
            onCancel={() => {
              revoke.value = undefined;
            }}
            onConfirm={async () => {
              await revokeTrustedDevice(revoke.value!.id);
              status.value = '通行密钥已移除';
              await reload();
            }}
          >
            移除「{revoke.value.name}」的登录验证资格，并退出当前会话以外的所有登录。请用通行密钥确认。
          </Confirm>
        )}
      </section>
    );
  };
});
