import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelay } from '../src/server/relay.js';
import { AccountClient } from '../src/client/account.js';
import { protectAccount } from '../src/shared/account-crypto.js';
import { TEST_TOTP_KEY, signedInDeviceFixture } from './secure-login-fixture.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('closes human registration while preserving existing sessions, login and invitation-authorized Agents', async () => {
  const devices = signedInDeviceFixture();
  cleanup.push(devices.dispose);
  const directory = mkdtempSync(join(tmpdir(), 'registration-policy-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const open = (registrationEnabled?: boolean, loginArtworkBase?: string) =>
    buildRelay({
      origin: 'https://chat.test',
      webRoot: '/nonexistent',
      assetOrigin: null,
      uploadOrigins: [],
      enrollmentSecret: 'registration-policy-test-enrollment-32',
      messaging: {
        database: join(directory, 'messaging.sqlite'),
        totpKey: TEST_TOTP_KEY,
        registrationEnabled,
        registrationCode: 'existing-private-code',
        loginArtworkBase,
      },
    });
  let relay = await open(undefined, 'https://user:test-secret@static.example.com/login/');
  cleanup.push(() => relay.app.close());
  const session = () => {
    let cookie = '';
    const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await relay.app.inject({
        url: `/api/im${path}`,
        method: method as 'GET',
        headers: { host: 'chat.test', origin: 'https://chat.test', cookie },
        payload: body as object,
      });
      if (response.cookies.length) cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (response.statusCode >= 400)
        throw Object.assign(Error(response.json().error), { status: response.statusCode });
      return response.json() as T;
    };
    return { request, account: devices.wrap(new AccountClient(request)) };
  };
  const existing = session();
  expect(await existing.request('/status')).toEqual({
    registrationEnabled: true,
    registrationRequiresCode: true,
  });
  await existing.account.register(
    'existing',
    'Existing',
    'strong-existing-password',
    'existing-private-code',
  );
  const user = existing.account.user!;
  const invitation = await existing.request<{ invitation: string }>('/agent-invitations', 'POST', {});

  await relay.app.close();
  relay = await open(false, 'https://static.example.com/login');
  expect(await session().request('/status')).toEqual({
    registrationEnabled: false,
    registrationRequiresCode: true,
    loginArtworkBase: 'https://static.example.com/login/',
  });
  expect(await existing.request('/me')).toMatchObject({ user: { id: user.id } });
  const login = session();
  await login.account.login('existing', 'strong-existing-password');
  expect(login.account.user?.id).toBe(user.id);

  await expect(session().request('/crypto/register', 'POST', {})).rejects.toMatchObject({
    status: 403,
    message: '本站已关闭注册',
  });
  await expect(
    session().account.register('blocked', 'Blocked', 'strong-blocked-password', 'existing-private-code'),
  ).rejects.toMatchObject({ status: 403, message: '本站已关闭注册' });
  const protectedAgent = await protectAccount('strong-agent-password');
  const agent = await session().request<{ user: { kind: string }; owner: { id: string } }>(
    '/agents/register',
    'POST',
    {
      invitation: invitation.invitation,
      username: 'existingagent',
      displayName: 'Existing owner Agent',
      vault: protectedAgent.vault,
    },
  );
  expect(agent.user.kind).toBe('agent');
  expect(agent.owner.id).toBe(user.id);
});
