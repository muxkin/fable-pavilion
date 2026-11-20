import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountClient } from '../src/client/account.js';
import { createSecrets } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';
import type { PairedHost } from '../src/web/sync-store.js';

const device = vi.hoisted(() => ({ securityBackup: vi.fn(), securityBackupChallenge: vi.fn() }));
vi.mock('../src/web/device-session', () => ({ deviceSession: device }));
import { backupAdapter } from '../src/web/adapter-security-backup.js';

const host = {
  hostId: 'synthetic-host',
  deviceId: 'synthetic-device',
  phoneId: 'synthetic-phone',
  ticket: 'synthetic-ticket',
  name: 'Synthetic computer',
} as PairedHost;
const user: ChatUser = {
  id: 'synthetic-owner',
  username: 'synthetic-owner',
  displayName: 'Synthetic',
  address: 'synthetic-owner@fixture.test',
  kind: 'human',
  encrypted: true,
  createdAt: 0,
};
beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://keybook.test' });
  device.securityBackup.mockReset();
  device.securityBackupChallenge.mockReset().mockResolvedValue({ nonce: 'synthetic-challenge' });
});
afterEach(() => vi.unstubAllGlobals());

it('repairs account confirmation even when the same revision already has both saved secrets', async () => {
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/prepare'))
      return {
        ticket: 'synthetic-prepare-ticket',
        document: {
          version: 1,
          origin: location.origin,
          account: { id: user.id, username: user.username, displayName: user.displayName },
          revision: 7,
          totpSecret: 'SYNTHETIC-TOTP-SECRET',
        },
      };
    if (path.endsWith('/seal')) return { proof: 'synthetic-import-proof' };
    throw Error('Unexpected synthetic request');
  });
  const owner = new AccountClient(request as AccountClient['request']);
  owner.activate(user, await createSecrets(), undefined, 7);
  device.securityBackup
    .mockResolvedValueOnce({
      supported: true,
      saved: true,
      revision: 7,
      hasTotp: true,
      hasRecovery: true,
      accountConfirmed: false,
    })
    .mockRejectedValueOnce(Error('Synthetic account metadata write failed'));
  await expect(backupAdapter(owner, owner.request, host, {})).rejects.toThrow('metadata write failed');
  expect(device.securityBackupChallenge).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
  device.securityBackup
    .mockResolvedValueOnce({
      supported: true,
      saved: true,
      revision: 7,
      hasTotp: true,
      hasRecovery: true,
      accountConfirmed: false,
    })
    .mockResolvedValueOnce({ ok: true, revision: 7, hasTotp: true, hasRecovery: true });
  await expect(backupAdapter(owner, owner.request, host, {})).resolves.toEqual({
    state: 'saved',
    hasRecovery: true,
  });
  expect(device.securityBackupChallenge).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(4);
});

it('keeps the saved-state fast path compatible with an older Native that has no confirmation field', async () => {
  const request = vi.fn();
  const owner = new AccountClient(request);
  owner.activate(user, await createSecrets(), undefined, 7);
  device.securityBackup.mockResolvedValue({
    supported: true,
    saved: true,
    revision: 7,
    hasTotp: true,
    hasRecovery: true,
  });
  await expect(backupAdapter(owner, owner.request, host, {})).resolves.toEqual({
    state: 'saved',
    hasRecovery: true,
  });
  expect(device.securityBackupChallenge).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
