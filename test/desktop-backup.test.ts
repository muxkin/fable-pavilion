import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { AccountClient } from '../src/client/account.js';
import { buildRelay } from '../src/server/relay.js';
import { TEST_TOTP_KEY } from './secure-login-fixture.js';
import { desktopBackupContract, type DesktopBackupRuntime } from './contracts/desktop-backup.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

desktopBackupContract(async (): Promise<DesktopBackupRuntime> => {
  const origin = 'http://localhost';
  const state = await mkdtemp(join(tmpdir(), 'desktop-backup-contract-'));
  const database = join(state, 'relay.sqlite');
  const relay = await buildRelay({
    origin,
    database,
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'synthetic-desktop-backup-contract-enrollment',
    messaging: { totpKey: TEST_TOTP_KEY },
  });
  await relay.app.ready();
  cleanups.push(async () => {
    await relay.app.close();
    await rm(state, { recursive: true, force: true });
  });
  function inspect<T>(action: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(`${database}.im.sqlite`);
    try {
      return action(db);
    } finally {
      db.close();
    }
  }
  return {
    origin,
    session() {
      let cookie = '';
      const raw: ReturnType<DesktopBackupRuntime['session']>['raw'] = async (path, method, body, options) => {
        const response = await relay.app.inject({
          method: method as 'POST',
          url: `/api/im${path}`,
          headers: {
            host: 'localhost',
            ...(options?.origin !== null ? { origin: options?.origin ?? origin } : {}),
            cookie,
          },
          payload: body as object,
        });
        if (response.cookies[0]) cookie = `${response.cookies[0].name}=${response.cookies[0].value}`;
        return {
          status: response.statusCode,
          body: response.statusCode === 204 ? undefined : response.json(),
        };
      };
      const request: AccountClient['request'] = async <T>(path: string, method = 'GET', body?: unknown) => {
        const response = await raw(path, method, body);
        if (response.status >= 400)
          throw Object.assign(Error(response.body.error), { status: response.status });
        return response.body as T;
      };
      return { account: new AccountClient(request), request, raw, cookie: () => cookie };
    },
    async expire(capability) {
      inspect((db) =>
        db
          .prepare('UPDATE im_desktop_backup_grants SET expires_at=? WHERE hash=?')
          .run(Date.now() - 1, createHash('sha256').update(capability).digest('hex')),
      );
    },
    async rows() {
      return inspect((db) => db.prepare('SELECT * FROM im_desktop_backup_grants').all());
    },
  };
});
