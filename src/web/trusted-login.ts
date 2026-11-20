import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { canonical, passwordKeys, recoveryKeys, type AccountVault } from '../shared/account-crypto';
import {
  sealTrustedLoginRoot,
  signDeviceLoginApproval,
  trustedLoginKeyFingerprint,
  type TrustedDevicePublicKey,
  type TrustedLoginEnvelope,
} from '../shared/trusted-device-crypto';
import { messaging } from './messaging/context';
import type { QrLoginHandle, TrustedLoginRequest } from '../client/account';
import type { QrInvitationCredentials } from './lite-login-invitation';

export {
  InvitationAtAnotherSite,
  parseQrInvitationUrl,
  qrLoginUrl,
  switchAndroidLoginSite,
  type QrInvitationCredentials,
} from './lite-login-invitation';

export { TrustedLoginRequired, type QrLoginHandle, type TrustedLoginRequest } from '../client/account';

type PendingLogin = { id: string; name: string; expiresAt: number };
type TrustedDevice = {
  id: string;
  name: string;
  createdAt: number;
  deviceType: 'singleDevice' | 'multiDevice';
};
export type QrApprovalRequest = PendingLogin & { publicKey: TrustedDevicePublicKey; deviceBound?: boolean };
export type QrInvitation = QrInvitationCredentials & { expiresAt: number };
export type QrInvitationStatus = { id: string; expiresAt: number } & (
  | { state: 'waiting' | 'approved' | 'completed' | 'cancelled' | 'expired' }
  | { state: 'claimed'; request: QrApprovalRequest }
);
export type TrustedDevicesState = {
  available: boolean;
  passkeyAvailable: boolean;
  passkeysHere?: boolean;
  recentlyVerified?: boolean;
  authenticators?: ExternalAuthenticator[];
  required: boolean;
  hasCredentials: boolean;
  devices: TrustedDevice[];
  totpAvailable: boolean;
  totpEnabled: boolean;
  events: TrustedLoginEvent[];
};
export type TrustedLoginEvent = {
  id: string;
  kind: 'login' | 'enrolled' | 'revoked' | 'recovered';
  name: string;
  createdAt: number;
};
export const trustedLoginEventLabels = {
  login: '新设备已登录',
  enrolled: '已登记新的可信设备',
  revoked: '已撤销可信设备',
  recovered: '账号已通过恢复码重置',
} as const;
type DeviceAction = 'totp-display' | 'totp-add' | 'qr' | 'revoke' | 'enroll';
export type ExternalAuthenticator = { id: string; name: string; createdAt: number };
type SetupGrant = { grant: string; expiresAt: number };
async function accountPasswordProof(identifier: string, password: string) {
  const { salt } = await messaging.request<{ salt: string }>('/crypto/parameters', 'POST', { identifier });
  return (await passwordKeys(password, salt)).auth;
}

export async function beginExternalAuthenticator(
  identifier: string,
  credentials?: { password: string; recovery: string },
  usePasskey = false,
): Promise<SetupGrant> {
  if (usePasskey) {
    const { grant, expiresAt } = await verifyDevice('totp-add');
    if (!grant || !expiresAt) throw new Error('验证未完成，请重试');
    return { grant, expiresAt };
  }
  let proof = {};
  if (credentials) {
    const [auth, recovery] = await Promise.all([
      accountPasswordProof(identifier, credentials.password),
      recoveryKeys(credentials.recovery),
    ]);
    proof = { auth, recoveryAuth: recovery.auth };
  }
  return messaging.request('/crypto/authenticators/options', 'POST', proof);
}

export async function removeExternalAuthenticator(identifier: string, id: string, password: string) {
  const auth = await accountPasswordProof(identifier, password);
  await messaging.request(`/crypto/authenticators/${encodeURIComponent(id)}`, 'DELETE', { auth });
}

export function trustedDevices(signal?: AbortSignal) {
  return messaging.request<TrustedDevicesState>('/crypto/trusted', 'GET', undefined, signal);
}

function requireWebAuthn() {
  if (!browserSupportsWebAuthn()) throw new Error('此操作需要支持通行密钥的浏览器和安全连接');
}

async function verifyDevice(action: DeviceAction, target?: string, envelope?: TrustedLoginEnvelope) {
  requireWebAuthn();
  const challenge = await messaging.request<{ id: string; options: PublicKeyCredentialRequestOptionsJSON }>(
    '/crypto/trusted/verify/options',
    'POST',
    { action, target },
  );
  const response = await startAuthentication({ optionsJSON: challenge.options });
  return messaging.request<{
    code?: string;
    expiresAt?: number;
    grant?: string;
    grantExpiresAt?: number;
    secret?: string;
    uri?: string;
    approval?: string;
  }>('/crypto/trusted/verify', 'POST', {
    id: challenge.id,
    response,
    envelope,
  });
}

export async function enrollTrustedDevice(
  identifier: string,
  password: string | undefined,
  name: string,
  needsApproval: boolean,
) {
  requireWebAuthn();
  const auth = password ? await accountPasswordProof(identifier, password) : undefined;
  const approval = needsApproval ? (await verifyDevice('enroll')).approval : undefined;
  const challenge = await messaging.request<{ id: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    '/crypto/trusted/enroll/options',
    'POST',
    { name, auth, approval },
  );
  const response = await startRegistration({ optionsJSON: challenge.options });
  await messaging.request('/crypto/trusted/enroll', 'POST', { id: challenge.id, response });
}

export function showCurrentLoginCode(signal?: AbortSignal) {
  return messaging.request<{ code: string; expiresAt: number }>('/crypto/totp/display', 'POST', {}, signal);
}

export function refreshCurrentLoginCode(grant?: string, signal?: AbortSignal) {
  return messaging.request<{ code: string; expiresAt: number }>(
    '/crypto/totp/display',
    'POST',
    grant ? { grant } : {},
    signal,
  );
}

export async function revokeTrustedDevice(id: string) {
  await verifyDevice('revoke', id);
}

export async function loadQrRequest(id: string, expectedFingerprint: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedFingerprint)) throw new Error('扫码链接缺少设备校验信息');
  const result = await messaging.request<QrApprovalRequest>(`/crypto/qr/${encodeURIComponent(id)}`);
  if ((await trustedLoginKeyFingerprint(result.publicKey)) !== expectedFingerprint)
    throw new Error('扫码链接与待登录设备不匹配');
  return result;
}

export async function approveQrLogin(request: QrApprovalRequest) {
  const { user, secrets, revision } = messaging.account;
  if (!user || !secrets) throw new Error('请先在可信设备上解锁账号');
  const envelope = await sealTrustedLoginRoot(secrets, {
    origin: location.origin,
    accountId: user.id,
    requestId: request.id,
    recipientPublicKey: request.publicKey,
  });
  let signature: string | undefined;
  if (request.deviceBound) {
    const latest = await messaging.request<{ vault: AccountVault; revision: number }>('/crypto/account');
    if (canonical(latest.vault.publicKeys) !== canonical(secrets.publicKeys))
      throw new Error('账号密钥已变化，请重新登录');
    signature = await signDeviceLoginApproval(secrets.signing, {
      origin: location.origin,
      accountId: user.id,
      revision: latest.revision,
      requestId: request.id,
      expiresAt: request.expiresAt,
      recipientPublicKey: request.publicKey,
      envelope,
    });
  }
  if (messaging.account.secrets !== secrets || messaging.account.revision !== revision)
    throw new Error('账号已变化，请重新打开登录请求');
  await messaging.request('/crypto/qr/approve', 'POST', { id: request.id, envelope, signature });
}

export function completeTrustedLogin(request: TrustedLoginRequest, code: string, password: string) {
  return messaging.account.completeTrustedLogin(request, code, password);
}

export function startQrLogin(identifier: string | undefined, name: string, signal?: AbortSignal) {
  return messaging.account.startQrLogin(identifier, name, signal);
}

export function parseQrLoginUrl(text: string) {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error('请扫描本应用的登录二维码');
  }
  if (url.origin !== location.origin || url.username || url.password)
    throw new Error('该二维码无法用于当前站点登录');
  if (
    url.pathname !== '/' ||
    url.hash ||
    !['profile', 'login-security'].includes(url.searchParams.get('page') ?? '')
  )
    throw new Error('请扫描本应用的登录二维码');
  const id = url.searchParams.get('login-qr');
  const fingerprint = url.searchParams.get('login-key');
  if (
    Array.from(url.searchParams.keys()).length !== 3 ||
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
    !fingerprint ||
    !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)
  )
    throw new Error('扫码链接不完整，请重新扫描新设备上的二维码');
  return { id, fingerprint };
}

export function checkQrLogin(handle: QrLoginHandle, signal?: AbortSignal) {
  return messaging.account.checkQrLogin(handle, location.origin, signal);
}

export function createQrInvitation(signal?: AbortSignal) {
  return messaging.request<QrInvitation>('/crypto/qr/invite', 'POST', {}, signal);
}

export function qrInvitationUrl({ id, secret }: QrInvitationCredentials) {
  const url = new URL('/?page=login-invite', location.origin);
  url.hash = new URLSearchParams({ invite: `${id}.${secret}` }).toString();
  return url.href;
}

export function qrInvitationStatus(id: string, signal?: AbortSignal) {
  return messaging.request<QrInvitationStatus>(
    `/crypto/qr/invite/${encodeURIComponent(id)}`,
    'GET',
    undefined,
    signal,
  );
}

export async function cancelQrInvitation(id: string) {
  await messaging.request('/crypto/qr/invite/cancel', 'POST', { id });
}

export function claimQrInvitation(
  { id, secret }: QrInvitationCredentials,
  name: string,
  signal?: AbortSignal,
) {
  return messaging.account.claimQrInvitation(id, secret, name, signal);
}
