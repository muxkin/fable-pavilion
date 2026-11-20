import type { ChatUser } from '../shared/messaging';

let startupSession: Promise<ChatUser | null> | undefined;
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

export function setStartupLoginMode(mode: 'recovery' | 'qr'): void {
  startupLoginMode = mode;
}

export function takeStartupLoginMode(): 'recovery' | 'qr' | undefined {
  const mode = startupLoginMode;
  startupLoginMode = undefined;
  return mode;
}
