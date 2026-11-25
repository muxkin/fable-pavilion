import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AccountClient, AuthenticatorSetupGrant } from '../client/account';
import { openPrivate, sealPrivate, type Ciphertext } from '../shared/account-crypto';
import type { DesktopAuthorization } from '../shared/desktop-authorization';
import { RpcError } from '../shared/rpc';
import { keybookRecoveryItem, keybookRecoverySchema } from '../shared/keybook-sync';
import { deviceSession } from './device-session';
import { diagnosticStatus, recordDiagnostic } from './diagnostics';
import type { PairedHost } from './sync-store';

const pendingKey = 'pavilion-keybook-recovery';
const ttl = 5 * 60_000;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
type Pending = { accountId: string; revision: number; expiresAt: number; ciphertext: Ciphertext };
export type BackupStatus = {
  supported: true;
  saved: boolean;
  revision?: number;
  hasTotp: boolean;
  hasRecovery: boolean;
  needsLocalUnlock?: boolean;
  accountConfirmed?: boolean;
};
type BackupDocument = {
  version: 1;
  origin: string;
  account: { id: string; username: string; displayName: string };
  revision: number;
  totpSecret?: string;
  recoveryCode?: string;
};
type Request = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
const context = (accountId: string, revision: number) => `fable-keybook-pending:${accountId}:${revision}`;

/** Native launchers may open another tab; only a short-lived, account-encrypted handoff is shared. */
export async function rememberRecoveryForAdapter(account: AccountClient, recoveryCode: string) {
  const user = account.user,
    secrets = account.secrets,
    revision = account.revision;
  if (!user || !secrets) return;
  const expiresAt = Date.now() + ttl;
  const ciphertext = await sealPrivate(secrets, context(user.id, revision), { recoveryCode, expiresAt });
  if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
  const encoded = JSON.stringify({ accountId: user.id, revision, expiresAt, ciphertext } satisfies Pending);
  localStorage.setItem(pendingKey, encoded);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    try {
      if (localStorage.getItem(pendingKey) === encoded) localStorage.removeItem(pendingKey);
    } catch {
      /* An unavailable browser store cannot reveal the encrypted handoff. */
    }
  }, ttl);
  if (typeof pendingTimer === 'object') pendingTimer.unref?.();
}
export async function pendingAdapterRecovery(account: AccountClient): Promise<string | undefined> {
  const user = account.user,
    secrets = account.secrets,
    revision = account.revision;
  if (!user || !secrets) return;
  try {
    const saved = keybookRecoverySchema.safeParse(await account.readItem(keybookRecoveryItem));
    if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
    if (saved.success && saved.data.accountId === user.id && saved.data.revision === revision)
      return saved.data.recoveryCode;
  } catch {
    // The short-lived local handoff can still bridge an unavailable account vault.
  }
  if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
  try {
    const pending = JSON.parse(localStorage.getItem(pendingKey) ?? 'null') as Pending | null;
    if (!pending) return;
    if (pending.expiresAt <= Date.now()) {
      localStorage.removeItem(pendingKey);
      return;
    }
    if (pending.accountId !== user.id || pending.revision !== revision) return;
    const opened = await openPrivate<{ recoveryCode: string; expiresAt: number }>(
      secrets,
      context(user.id, revision),
      pending.ciphertext,
    );
    if (
      opened.expiresAt !== pending.expiresAt ||
      opened.expiresAt <= Date.now() ||
      account.user !== user ||
      account.secrets !== secrets ||
      account.revision !== revision
    )
      return;
    return opened.recoveryCode;
  } catch {
    return;
  }
}

/** Only a client which already possesses the original code may create this E2EE vault item. */
export async function persistAdapterRecovery(account: AccountClient, recoveryCode: string) {
  const user = account.user,
    secrets = account.secrets,
    revision = account.revision;
  if (!user || !secrets) return;
  const value = keybookRecoverySchema.parse({ version: 1, accountId: user.id, revision, recoveryCode });
  const existing = keybookRecoverySchema.safeParse(await account.readItem(keybookRecoveryItem));
  if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
  if (
    existing.success &&
    (existing.data.accountId !== user.id ||
      existing.data.revision > revision ||
      (existing.data.revision === revision && existing.data.recoveryCode !== recoveryCode))
  )
    throw Error('账号恢复码已变化，请刷新账号后重试');
  await rememberRecoveryForAdapter(account, recoveryCode);
  if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
  if (
    existing.success &&
    existing.data.accountId === user.id &&
    existing.data.revision === revision &&
    existing.data.recoveryCode === recoveryCode
  )
    return;
  try {
    await account.writeItem(keybookRecoveryItem, value);
  } catch (cause) {
    if ((cause as { status?: number }).status !== 409) throw cause;
    await account.refreshItems();
    if (account.user !== user || account.secrets !== secrets || account.revision !== revision) return;
    const raced = keybookRecoverySchema.safeParse(await account.readItem(keybookRecoveryItem));
    if (
      !raced.success ||
      raced.data.accountId !== user.id ||
      raced.data.revision !== revision ||
      raced.data.recoveryCode !== recoveryCode
    )
      throw cause;
  }
}

export async function backupAdapter(
  account: AccountClient,
  request: Request,
  host: PairedHost,
  options: {
    authorization?: DesktopAuthorization;
    setup?: AuthenticatorSetupGrant;
    recoveryCode?: string;
    signal?: AbortSignal;
  },
) {
  const user = account.user,
    secrets = account.secrets,
    revision = account.revision;
  if (!user || !secrets) throw Error('请先解锁账号');
  const check = () => {
    options.signal?.throwIfAborted();
    if (account.user !== user || account.secrets !== secrets || account.revision !== revision)
      throw Error('账号已切换，请重试');
  };
  const status = await deviceSession.securityBackup<BackupStatus>(host, undefined, options.signal);
  check();
  if (status?.supported !== true) return { state: 'unsupported' as const };
  if (
    !options.authorization &&
    !options.setup &&
    status.saved &&
    status.revision === revision &&
    status.accountConfirmed !== false &&
    (!options.recoveryCode || status.hasRecovery)
  )
    return { state: 'saved' as const, hasRecovery: status.hasRecovery };
  if (status.needsLocalUnlock) return { state: 'protected' as const };
  const challenge =
    !options.authorization && !options.setup
      ? await deviceSession.securityBackupChallenge(host, user.id, revision, options.signal)
      : undefined;
  check();
  const prepared = await request<{ ticket: string; document: BackupDocument }>(
    '/crypto/desktop-backup/prepare',
    'POST',
    {
      hostId: host.hostId,
      deviceId: host.deviceId,
      ...(options.authorization
        ? { authorization: options.authorization }
        : options.setup
          ? { setupGrant: options.setup.grant }
          : { challenge }),
    },
    options.signal,
  );
  check();
  if (
    prepared.document.account.id !== user.id ||
    prepared.document.revision !== revision ||
    prepared.document.origin !== location.origin
  )
    throw Error('秘钥簿账号状态已变化，请重试');
  const document = JSON.stringify({
    ...prepared.document,
    ...(options.recoveryCode ? { recoveryCode: options.recoveryCode } : {}),
  });
  const payloadHash = bytesToHex(sha256(new TextEncoder().encode(document)));
  const { proof } = await request<{ proof: string }>(
    '/crypto/desktop-backup/seal',
    'POST',
    { ticket: prepared.ticket, payloadHash },
    options.signal,
  );
  check();
  let saved: { ok: true; revision: number; hasTotp: boolean; hasRecovery: boolean };
  try {
    saved = await deviceSession.securityBackup(host, { proof, document }, options.signal);
  } catch (cause) {
    if (cause instanceof RpcError && cause.status === 409) return { state: 'protected' as const };
    throw cause;
  }
  check();
  if (!saved?.ok || saved.revision !== revision) throw Error('秘钥簿尚未保存，请重试');
  return { state: 'saved' as const, hasRecovery: saved.hasRecovery };
}

export async function backupKnownAdapters(
  account: AccountClient,
  request: Request,
  setup: AuthenticatorSetupGrant | undefined,
  recoveryCode: string,
) {
  await persistAdapterRecovery(account, recoveryCode);
  const scope = deviceSession.cache.scope,
    user = account.user;
  if (!user || scope !== user.id) return;
  const hosts = await deviceSession.cache.hosts(scope);
  let saved = 0,
    pending = 0;
  for (const host of hosts) {
    if (account.user !== user || deviceSession.cache.scope !== scope) break;
    try {
      const result = await backupAdapter(account, request, host, {
        recoveryCode,
        signal: AbortSignal.timeout(10000),
      }).catch((error) => {
        if (!setup || setup.expiresAt <= Date.now()) throw error;
        return backupAdapter(account, request, host, {
          setup,
          recoveryCode,
          signal: AbortSignal.timeout(10000),
        });
      });
      if (result.state === 'saved') saved++;
      else if (result.state === 'protected') pending++;
    } catch {
      pending++;
    }
  }
  return { saved, pending };
}

const adapterBackups = new Map<string, Promise<void>>();

export function queueAdapterBackup(
  account: AccountClient,
  request: Request,
  host: PairedHost,
  authorization?: DesktopAuthorization,
) {
  const { user, secrets, revision, recoveryCode } = account;
  if (!user || !secrets) return;
  const key = JSON.stringify([user.id, revision, host.hostId, host.ticket]);
  if (adapterBackups.has(key)) return;
  const current = () => account.user === user && account.secrets === secrets && account.revision === revision;
  const run = async () => {
    if (recoveryCode) await persistAdapterRecovery(account, recoveryCode).catch(() => {});
    const recovery = recoveryCode ?? (await pendingAdapterRecovery(account));
    let failure: unknown;
    for (const delay of [0, 1000, 4000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!current()) return;
      try {
        const result = await backupAdapter(account, request, host, {
          authorization,
          recoveryCode: recovery,
          signal: AbortSignal.timeout(12000),
        });
        if (result.state !== 'protected') return;
        failure = { status: 409 };
        break;
      } catch (cause) {
        failure = cause;
        if (cause instanceof RpcError && [400, 401, 403, 404, 409].includes(cause.status)) break;
      }
    }
    if (current())
      recordDiagnostic({
        code: 'adapter-backup-failed',
        status: diagnosticStatus(failure),
      });
  };
  adapterBackups.set(
    key,
    run().finally(() => adapterBackups.delete(key)),
  );
}
