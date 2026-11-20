import type { PairedHost } from '../sync-store';

const key = (scope: string) => `pocket-workbench-devices:${scope}`;

export function recentWorkbenchDevices(scope: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? '[]');
    if (Array.isArray(stored)) return stored.filter((id) => typeof id === 'string');
  } catch {
    // Workbench stays usable without local storage.
  }
  return [];
}

export function rememberWorkbenchDevice(scope: string, id: string, hosts: PairedHost[]) {
  const previous = recentWorkbenchDevices(scope);
  const paired = new Set(hosts.map((host) => host.hostId));
  const next = [id, ...previous.filter((host) => host !== id && paired.has(host))];
  if (previous.length === next.length && previous.every((host, index) => host === next[index])) return;
  try {
    localStorage.setItem(key(scope), JSON.stringify(next));
  } catch {
    // Opening a device does not depend on persisting its position.
  }
}
