import type { ChatUser } from '../shared/messaging';

export interface StartupAccountStatus {
  registrationEnabled: boolean;
  registrationRequiresCode: boolean;
  deviceLoginOnly?: boolean;
  loginArtworkBase?: string;
}

let startupSession: Promise<ChatUser | null> | undefined;
let startupStatus: Promise<StartupAccountStatus | null> | undefined;
let resolvedStartupStatus: StartupAccountStatus | undefined;
let startupLoginMode: 'recovery' | 'qr' | undefined;

export function setStartupSession(promise: Promise<ChatUser | null>): void {
  startupSession = promise;
  void promise.catch(() => {});
}

export function takeStartupSession(): Promise<ChatUser | null> | undefined {
  const session = startupSession;
  startupSession = undefined;
  return session;
}

export function setStartupStatus(promise: Promise<StartupAccountStatus | null>): void {
  resolvedStartupStatus = undefined;
  startupStatus = promise
    .then((value) => {
      if (value) resolvedStartupStatus = value;
      return value;
    })
    .catch(() => null);
}

export async function awaitStartupStatus(timeoutMs = 1500): Promise<StartupAccountStatus | null> {
  if (resolvedStartupStatus) return resolvedStartupStatus;
  if (!startupStatus) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      startupStatus,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function peekStartupStatus(): StartupAccountStatus | undefined {
  return resolvedStartupStatus;
}

export function setStartupLoginMode(mode: 'recovery' | 'qr'): void {
  startupLoginMode = mode;
}

export function takeStartupLoginMode(): 'recovery' | 'qr' | undefined {
  const mode = startupLoginMode;
  startupLoginMode = undefined;
  return mode;
}
