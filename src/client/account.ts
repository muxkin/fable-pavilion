import {
  protectAccount,
  replaceAccountRecovery,
  passwordKeys,
  recoveryKeys,
  unlockAccount,
  fingerprint,
  canonical,
  openPrivate,
  sealPrivate,
  privateId,
  type AccountSecrets,
  type AccountVault,
  type PublicAccountKeys,
  type Ciphertext,
} from '../shared/account-crypto.js';
import type { UsageResetScope } from '../shared/usage.js';
import type { ChatUser } from '../shared/messaging.js';
import { MessagingError } from './messaging.js';
import {
  createTrustedLoginKey,
  openTrustedLoginRoot,
  trustedLoginPossessionProof,
  type TrustedDevicePublicKey,
  type TrustedLoginEnvelope,
  type TrustedLoginKey,
} from '../shared/trusted-device-crypto.js';

export type Request = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface VaultItem {
  id: string;
  revision: number;
  ciphertext: Ciphertext | null;
}
interface AccountLogin {
  user: ChatUser;
  vault: AccountVault;
  revision: number;
}
export interface TrustedLoginRequest {
  id: string;
  claim: string;
  expiresAt: number;
  deviceBound?: boolean;
}
type LoginContext = { trusted: true; deviceName?: string };
export interface QrLoginHandle extends TrustedLoginRequest {
  key: TrustedLoginKey;
  proof: string;
}
export class TrustedLoginRequired extends Error {
  constructor(readonly request: TrustedLoginRequest) {
    super('请在可信设备上查看这次登录的动态码');
  }
}

export type AuthenticatorSetupGrant = { grant: string; expiresAt: number };

export class AccountClient {
  authenticatorSetup?: AuthenticatorSetupGrant;
  recoveredSecurity = false;
  user?: ChatUser;
  secrets?: AccountSecrets;
  vault?: AccountVault;
  revision = 0;
  recoveryCode = '';
  recoveryLogin = '';
  private pins = new Map<string, PublicAccountKeys>();
  private items = new Map<string, VaultItem>();
  private listeners = new Set<() => void>();
  private stateVersion = 0;
  constructor(
    readonly request: Request,
    private readonly deviceLoginOnly = false,
  ) {}
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed() {
    for (const fn of this.listeners) fn();
  }
  async register(
    username: string,
    displayName: string,
    password: string,
    registrationCode?: string,
    deviceOnly = false,
  ) {
    deviceOnly ||= this.deviceLoginOnly;
    const protectedAccount = await protectAccount(password, undefined, deviceOnly);
    const result = await this.request<{
      user: ChatUser;
      vault: AccountVault;
      authenticatorSetup?: AuthenticatorSetupGrant;
    }>('/crypto/register', 'POST', {
      username,
      displayName,
      registrationCode,
      vault: protectedAccount.vault,
      auth: protectedAccount.auth,
      recoveryAuth: protectedAccount.recoveryAuth,
    });
    this.activate(result.user, protectedAccount.secrets, result.vault, 1);
    this.recoveryCode = protectedAccount.recoveryCode;
    this.authenticatorSetup = deviceOnly ? undefined : result.authenticatorSetup;
    return result;
  }
  async login(identifier: string, password: string, recovery = false, context?: LoginContext) {
    if (this.deviceLoginOnly && !recovery) throw Error('请使用已授权设备扫码登录，或使用恢复码恢复账号');
    const parameters = await this.request<{ salt: string }>('/crypto/parameters', 'POST', { identifier });
    const keys = recovery ? await recoveryKeys(password) : await passwordKeys(password, parameters.salt!);
    const result = await this.request<AccountLogin | { trustedLogin: TrustedLoginRequest }>(
      '/crypto/login',
      'POST',
      { identifier, auth: keys.auth, recovery, ...context },
    );
    if ('trustedLogin' in result) throw new TrustedLoginRequired(result.trustedLogin);
    return this.finishLogin(
      result,
      async () => (await unlockAccount(result.vault, password, recovery)).secrets,
      recovery ? password : undefined,
    );
  }
  async completeTrustedLogin(challenge: TrustedLoginRequest, code: string, password: string) {
    const { id, claim } = challenge;
    const result = await this.request<AccountLogin>('/crypto/login/code', 'POST', { id, claim, code });
    return this.finishLogin(result, async () => (await unlockAccount(result.vault, password)).secrets);
  }
  /** Restore local keys using an existing complete session; this never signs in or revokes cookies. */
  async unlockSession(expectedUser: ChatUser, password: string): Promise<AccountLogin> {
    const expectedId = expectedUser.id;
    const version = this.stateVersion,
      user = this.user,
      previousSecrets = this.secrets;
    const unchanged = () => {
      if (
        this.stateVersion !== version ||
        this.user !== user ||
        this.secrets !== previousSecrets ||
        (this.user && this.user.id !== expectedId)
      )
        throw Error('账号已切换，请重新解锁');
    };
    const checkIdentity = (current: ChatUser | null) => {
      if (!current) throw new MessagingError(401, '登录状态已失效，请重新登录');
      if (current.id !== expectedId || current.kind !== 'human' || !current.encrypted)
        throw Error('账号已切换，请重新解锁');
      return current;
    };
    unchanged();
    const first = await this.request<{ user: ChatUser | null }>('/me');
    unchanged();
    checkIdentity(first.user);
    const snapshot = await this.request<{ vault: AccountVault; revision: number }>('/crypto/account');
    unchanged();
    let secrets: AccountSecrets;
    try {
      secrets = (await unlockAccount(snapshot.vault, password)).secrets;
    } catch {
      unchanged();
      throw Error('解锁失败，请检查账号密码');
    }
    unchanged();
    const latest = await this.request<{ vault: AccountVault; revision: number }>('/crypto/account');
    unchanged();
    if (latest.revision !== snapshot.revision || canonical(latest.vault) !== canonical(snapshot.vault))
      throw Error('账号数据已变化，请重新解锁');
    const current = await this.request<{ user: ChatUser | null }>('/me');
    unchanged();
    const verifiedUser = checkIdentity(current.user);
    this.activate(verifiedUser, secrets, latest.vault, latest.revision);
    return { user: verifiedUser, vault: latest.vault, revision: latest.revision };
  }
  async startQrLogin(
    identifier: string | undefined,
    name: string,
    signal?: AbortSignal,
  ): Promise<QrLoginHandle> {
    return this.beginQrLogin(
      '/crypto/qr/start',
      identifier === undefined ? { name } : { identifier, name },
      signal,
    );
  }
  async claimQrInvitation(id: string, secret: string, name: string, signal?: AbortSignal) {
    return this.beginQrLogin('/crypto/qr/invite/claim', { id, secret, name }, signal);
  }
  private async beginQrLogin(path: string, request: Record<string, string>, signal?: AbortSignal) {
    const key = await createTrustedLoginKey();
    const { proofKey, ...challenge } = await this.request<
      TrustedLoginRequest & { proofKey: TrustedDevicePublicKey }
    >(path, 'POST', { ...request, publicKey: key.publicKey }, signal);
    const proof = await trustedLoginPossessionProof(key.privateKey, proofKey, challenge.id);
    return { ...challenge, key, proof, deviceBound: this.deviceLoginOnly || challenge.deviceBound };
  }
  async checkQrLogin(
    handle: QrLoginHandle,
    origin: string,
    signal?: AbortSignal,
    options?: { refreshItems?: boolean },
  ) {
    const { id, claim, key, proof } = handle;
    const result = await this.request<
      { pending: true } | (AccountLogin & { envelope: TrustedLoginEnvelope })
    >('/crypto/qr/redeem', 'POST', { id, claim, proof }, signal);
    if ('pending' in result) return result;
    return this.finishLogin(
      result,
      () =>
        openTrustedLoginRoot(
          result.vault,
          key,
          { origin, requestId: id, accountId: result.user.id, recipientPublicKey: key.publicKey },
          result.envelope,
        ),
      undefined,
      signal,
      options?.refreshItems !== false,
    );
  }
  private async finishLogin<T extends AccountLogin>(
    result: T,
    unlock: () => Promise<AccountSecrets>,
    recovery?: string,
    signal?: AbortSignal,
    refreshItems = true,
  ): Promise<T> {
    try {
      const secrets = await unlock();
      signal?.throwIfAborted();
      this.activate(result.user, secrets, result.vault, result.revision);
      if (recovery) this.recoveryLogin = recovery;
      if (refreshItems) await this.refreshItems();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      await this.request('/logout', 'POST', {}).catch(() => {});
      this.lock();
      throw error;
    }
  }
  async confirmUsageReset(user: ChatUser, password: string, scope: UsageResetScope) {
    const { salt } = await this.request<{ salt: string }>('/crypto/parameters', 'POST', {
      identifier: user.username,
    });
    const { auth } = await passwordKeys(password, salt);
    return this.request<{ proof: string }>('/crypto/usage-reset/confirm', 'POST', {
      ...scope,
      accountId: user.id,
      auth,
    });
  }
  async changePassword(current: string, next: string, recovery = false) {
    if (!this.secrets || !this.vault) throw Error('请先解锁账号');
    const latest = await this.request<{ vault: AccountVault; revision: number; deviceLoginOnly?: boolean }>(
      '/crypto/account',
    );
    const deviceOnly = this.deviceLoginOnly || !latest.vault.password || latest.deviceLoginOnly;
    const verified =
      recovery || latest.vault.password
        ? await unlockAccount(latest.vault, current, recovery)
        : { auth: (await passwordKeys(current, latest.vault.salt)).auth, secrets: this.secrets };
    if (verified.secrets.root !== this.secrets.root) throw Error('账号密钥已变化');
    const protectedAccount = await protectAccount(next, this.secrets, deviceOnly);
    const result = await this.request<{ revision: number; authenticatorSetup?: AuthenticatorSetupGrant }>(
      '/crypto/password',
      'POST',
      {
        currentAuth: verified.auth,
        recovery,
        revision: latest.revision,
        vault: protectedAccount.vault,
        auth: protectedAccount.auth,
        recoveryAuth: protectedAccount.recoveryAuth,
      },
    );
    this.vault = protectedAccount.vault;
    this.revision = result.revision;
    this.recoveryCode = protectedAccount.recoveryCode;
    this.authenticatorSetup = result.authenticatorSetup;
    this.recoveredSecurity = recovery;
    this.changed();
  }
  async rotateRecovery(password: string) {
    const { user, secrets } = this;
    if (!user || !secrets) throw Error('请先解锁账号');
    const latest = await this.request<{ vault: AccountVault; revision: number }>('/crypto/account');
    const verified = latest.vault.password
      ? await unlockAccount(latest.vault, password)
      : { auth: (await passwordKeys(password, latest.vault.salt)).auth, secrets };
    if (verified.secrets.root !== secrets.root || this.user !== user) throw Error('账号状态已变化');
    const { recoveryCode, recoveryAuth, recovery } = await replaceAccountRecovery(secrets);
    const { revision, deviceOnly } = await this.request<{ revision: number; deviceOnly?: boolean }>(
      '/crypto/recovery/rotate',
      'POST',
      {
        revision: latest.revision,
        auth: verified.auth,
        recoveryAuth,
        recovery,
      },
    );
    if (this.user !== user || this.secrets !== secrets) return;
    this.vault = { ...latest.vault, recovery };
    if (deviceOnly) delete this.vault.password;
    this.revision = revision;
    this.recoveryCode = recoveryCode;
    this.authenticatorSetup = undefined;
    this.recoveredSecurity = false;
    this.changed();
  }

  activate(user: ChatUser, secrets: AccountSecrets, vault?: AccountVault, revision = 0) {
    this.lock();
    this.user = user;
    this.secrets = secrets;
    this.vault = vault && this.deviceLoginOnly ? { ...vault, password: undefined } : vault;
    this.revision = revision;
    this.pins.set(user.id, secrets.publicKeys);
    this.changed();
  }
  lock() {
    this.stateVersion++;
    this.authenticatorSetup = undefined;
    this.recoveredSecurity = false;
    this.user = undefined;
    this.secrets = undefined;
    this.vault = undefined;
    this.recoveryCode = '';
    this.recoveryLogin = '';
    this.pins.clear();
    this.items.clear();
    this.changed();
  }
  async refreshItems() {
    if (!this.secrets) return [];
    const user = this.user!,
      secrets = this.secrets;
    const { items } = await this.request<{ items: VaultItem[] }>(`/crypto/items?accountId=${user.id}`);
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    this.items = new Map(items.map((item) => [item.id, item]));
    this.changed();
    return items;
  }
  async readItem<T>(name: string): Promise<T | undefined> {
    if (!this.secrets) throw Error('请先解锁账号');
    const user = this.user!,
      secrets = this.secrets;
    const id = await privateId(secrets, name),
      item = this.items.get(id);
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    return item?.ciphertext ? openPrivate<T>(secrets, `vault:${user.id}:${id}`, item.ciphertext) : undefined;
  }
  async writeItem(name: string, value: unknown | null) {
    if (!this.secrets) throw Error('请先解锁账号');
    const user = this.user!,
      secrets = this.secrets;
    const id = await privateId(secrets, name);
    const ciphertext = value === null ? null : await sealPrivate(secrets, `vault:${user.id}:${id}`, value);
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    const previous = this.items.get(id);
    await this.writeCiphertext(id, ciphertext, previous?.revision ?? 0);
  }
  async writeCiphertext(id: string, ciphertext: Ciphertext | null, revision: number) {
    if (!this.secrets || !this.user) throw Error('请先解锁账号');
    const user = this.user,
      secrets = this.secrets;
    const result = await this.request<{ revision: number }>(`/crypto/items/${id}`, 'PUT', {
      accountId: user.id,
      revision,
      ciphertext,
    });
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    this.items.set(id, { id, ciphertext, revision: result.revision });
  }
  async publicKeys(id: string) {
    if (!this.secrets) throw Error('请先解锁账号');
    const user = this.user,
      secrets = this.secrets;
    if (id === this.user?.id) return this.secrets.publicKeys;
    const cached = this.pins.get(id);
    if (cached) return cached;
    const { publicKeys } = await this.request<{ publicKeys: PublicAccountKeys }>(
      `/crypto/keys/${encodeURIComponent(id)}`,
    );
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    const pinned = this.pins.get(id) ?? (await this.readItem<PublicAccountKeys>(`contact-key:${id}`));
    if (pinned && (await fingerprint(pinned)) !== (await fingerprint(publicKeys)))
      throw Error('联系人加密身份已变化，请核对安全码后再继续');
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    if (!pinned) {
      try {
        await this.writeItem(`contact-key:${id}`, publicKeys);
      } catch {
        await this.refreshItems();
        const raced = await this.readItem<PublicAccountKeys>(`contact-key:${id}`);
        if (!raced || canonical(raced) !== canonical(publicKeys))
          throw Error('无法保存联系人加密身份，请重试');
      }
    }
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    this.pins.set(id, publicKeys);
    return publicKeys;
  }
}
