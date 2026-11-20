import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type {
  MessageHandler,
  MessageRoute,
  MessagingHttp,
  MessagingReply,
  MessagingRequest,
} from '../src/server/messaging/http.js';
import { MessagingStore } from '../src/server/messaging/store.js';
import { ChatError, digest } from '../src/server/messaging/store-core.js';
import { AccountTotp } from '../src/server/messaging/totp.js';
import { DesktopEnrollmentStore } from '../src/server/desktop-authorization.js';
import { registerDesktopBackups } from '../src/server/messaging/desktop-backup.js';
import { protectAccount } from '../src/shared/account-crypto.js';
import { desktopAuthorizationProof } from '../src/shared/desktop-authorization.js';
import { base64, createIdentity, identityKey } from '../src/shared/secure-channel.js';

const origin = 'https://keybook.test';
const stores: MessagingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it.each(['desktop', 'session', 'revision'] as const)(
  'rechecks %s authorization after asynchronous recovery proof verification',
  async (changed) => {
    const store = new MessagingStore(':memory:');
    stores.push(store);
    const protectedAccount = await protectAccount('synthetic-keybook-race-password');
    const user = store.createUser('human', 'keybook_race', 'Race fixture', 'synthetic-password-hash');
    store.db
      .prepare('INSERT INTO im_account_crypto VALUES (?,?,?,?)')
      .run(user.id, JSON.stringify(protectedAccount.vault), 'synthetic-recovery-hash', 1);
    const token = store.issueSession(user.id).token;
    const totp = new AccountTotp(store.db, randomBytes(32).toString('base64url'));
    totp.enable(user.id);
    const desktops = new DesktopEnrollmentStore(store.db, new Set([origin]));
    const identity = await createIdentity();
    const intent = {
      hostId: identity.peerId,
      name: 'Race fixture computer',
      ticket: 'a'.repeat(64),
      issuedAt: Date.now(),
    };
    const authorization = {
      ...intent,
      signature: base64(await identityKey(identity).sign(desktopAuthorizationProof(origin, intent))),
    };
    expect(await desktops.approve(user.id, authorization, origin)).toBe('ok');
    const routes = new Map<string, MessageHandler>();
    const route: MessageRoute = (path: string, ...args: unknown[]) => {
      routes.set(path, args.at(-1) as MessageHandler);
    };
    const app: MessagingHttp = {
      get: route,
      post: route,
      put: route,
      patch: route,
      delete: route,
      addHook() {},
      setErrorHandler() {},
    };
    let started!: () => void, release!: () => void;
    const verifying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerDesktopBackups(app, {
      origin,
      store,
      totp,
      desktops: {
        approve: (...args) => desktops.approve(...args),
        list: (account) => desktops.list(account),
        revoke: (...args) => desktops.revoke(...args),
        ready: () => false,
      },
      token: (request) => request.cookies.owner ?? '',
      human(request) {
        const actor = store.authenticate(request.cookies.owner ?? '');
        if (!actor) throw new ChatError(401, 'Signed-in fixture required');
        return actor;
      },
      authorizeSetup() {
        throw Error('This fixture uses a real signed desktop authorization');
      },
      take() {},
      async verifyPassword(proof, expected) {
        // Integration contracts exercise the real KDF; only its asynchronous completion is controlled here.
        expect(proof === protectedAccount.recoveryAuth).toBe(true);
        expect(expected).toBe('synthetic-recovery-hash');
        started();
        await gate;
        return true;
      },
    });
    const call = (path: string, body: unknown, signedIn = true) =>
      Promise.resolve(
        routes.get(`/crypto/desktop-backup/${path}`)!(
          {
            url: `/crypto/desktop-backup/${path}`,
            method: 'POST',
            origin,
            headers: { origin },
            cookies: signedIn ? { owner: token } : {},
            body,
            params: {},
            query: {},
            clientAddress: () => '127.0.0.1',
          } satisfies MessagingRequest,
          {} as MessagingReply,
        ),
      ) as Promise<any>;
    const scope = { hostId: identity.peerId, deviceId: randomUUID() };
    const prepared = await call('prepare', { ...scope, authorization });
    const payloadHash = createHash('sha256').update(JSON.stringify(prepared.document)).digest('hex');
    const sealed = await call('seal', { ticket: prepared.ticket, payloadHash });
    const pending = call(
      'redeem',
      {
        ...scope,
        proof: sealed.proof,
        payloadHash,
        totpHash: digest(prepared.document.totpSecret),
        recoveryAuth: protectedAccount.recoveryAuth,
      },
      false,
    );
    await verifying;
    if (changed === 'desktop') expect(desktops.revoke(user.id, identity.peerId)).toBe(true);
    else if (changed === 'session')
      store.db.prepare('DELETE FROM im_sessions WHERE hash=?').run(digest(token));
    else store.db.prepare('UPDATE im_account_crypto SET revision=revision+1 WHERE user_id=?').run(user.id);
    release();
    await expect(pending).rejects.toMatchObject({ statusCode: 404 });
    expect(
      store.db.prepare('SELECT 1 FROM im_desktop_backup_grants WHERE hash=?').get(digest(sealed.proof)),
    ).toBeDefined();
  },
);
