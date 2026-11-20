import type { AccountClient } from '../client/account';
import type { Request } from '../client/account';
import { backupAdapter, pendingAdapterRecovery, persistAdapterRecovery } from './adapter-security-backup';
import { deviceSession } from './device-session';

/** One selected, authenticated computer at a time; no background fan-out to the host list. */
export function startAdapterKeybookSync(account: AccountClient, request: Request) {
  const retries = [1000, 4000, 15000, 30000, 60000];
  const states = new Map<
    string,
    { attempts: number; next: number; saved: boolean; hasRecovery: boolean; unsupported: boolean }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let running = false,
    again = false,
    stopped = false;
  let owner = account.user?.id,
    secrets = account.secrets,
    revision = account.revision;
  let connection = '';
  let setupAttempts = 0;
  const selectedConnection = () => {
    const host = deviceSession.host;
    return JSON.stringify([host?.hostId, host?.deviceId, host?.ticket, deviceSession.online]);
  };
  function schedule(delay = 350) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  }
  function changed(force = false) {
    const switched =
      owner !== account.user?.id || secrets !== account.secrets || revision !== account.revision;
    if (switched) {
      active?.abort();
      states.clear();
      owner = account.user?.id;
      secrets = account.secrets;
      revision = account.revision;
      setupAttempts = 0;
    }
    const next = selectedConnection();
    if (next !== connection || force) {
      active?.abort();
      connection = next;
      setupAttempts = 0;
      for (const state of states.values()) {
        state.attempts = 0;
        state.next = 0;
        state.saved = false;
        state.unsupported = false;
      }
    }
    if (running) again = true;
    else schedule();
  }
  async function run() {
    if (stopped || running || document.hidden || !navigator.onLine || setupAttempts >= retries.length) return;
    const user = account.user,
      unlocked = account.secrets,
      currentRevision = account.revision,
      currentConnection = selectedConnection();
    if (!user || !unlocked || deviceSession.cache.scope !== user.id) return;
    running = true;
    again = false;
    const abort = new AbortController();
    active = abort;
    const current = () =>
      !abort.signal.aborted &&
      !stopped &&
      account.user === user &&
      account.secrets === unlocked &&
      account.revision === currentRevision &&
      selectedConnection() === currentConnection;
    try {
      if (account.recoveryCode) {
        try {
          await persistAdapterRecovery(account, account.recoveryCode);
        } catch {
          /* Keep the original in the security wizard; retry while its account remains unlocked. */
        }
      }
      if (!current()) return;
      const selected = deviceSession.host;
      if (!selected || !deviceSession.online) return;
      const hosts = await deviceSession.cache.hosts(user.id);
      setupAttempts = 0;
      const host = hosts.find(
        (host) =>
          host.hostId === selected.hostId &&
          host.deviceId === selected.deviceId &&
          host.ticket === selected.ticket,
      );
      if (!host || !current()) return;
      const key = `${user.id}:${currentRevision}:${host.hostId}:${host.deviceId}:${host.ticket}`;
      const state = states.get(key) ?? {
        attempts: 0,
        next: 0,
        saved: false,
        hasRecovery: false,
        unsupported: false,
      };
      states.set(key, state);
      if ((state.saved && state.hasRecovery) || state.unsupported || state.attempts >= retries.length) return;
      if (state.next > Date.now()) {
        schedule(state.next - Date.now());
        return;
      }
      const recoveryCode = account.recoveryCode || (await pendingAdapterRecovery(account));
      if (!current()) return;
      if (state.saved && !recoveryCode) return;
      if (state.saved) {
        state.saved = false;
        state.attempts = 0;
      }
      try {
        const result = await backupAdapter(account, request, host, {
          recoveryCode,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
        });
        if (!current()) return;
        if (result.state === 'saved' || result.state === 'unsupported') {
          state.saved = true;
          state.unsupported = result.state === 'unsupported';
          state.hasRecovery = result.state === 'saved' && result.hasRecovery;
          return;
        }
      } catch {
        if (!current()) return;
      }
      state.next = Date.now() + retries[state.attempts++];
      if (state.attempts < retries.length) schedule(state.next - Date.now());
    } catch {
      if (current() && setupAttempts < retries.length) schedule(retries[setupAttempts++]);
    } finally {
      if (active === abort) active = undefined;
      running = false;
      if (again && !stopped) schedule();
    }
  }
  const unaccount = account.onChange(() => changed());
  const undevice = deviceSession.onChange(() => changed());
  const wake = () => {
    if (!document.hidden) changed(true);
    else active?.abort();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  changed();
  return () => {
    stopped = true;
    active?.abort();
    clearTimeout(timer);
    states.clear();
    unaccount();
    undevice();
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
