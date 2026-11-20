import { createDecipheriv, createECDH, randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { MessagingStore } from './messaging-fixtures.js';
import { PushNotifications } from '../src/server/messaging/notifications.js';
import { CallStore } from '../src/server/messaging/calls.js';

it('routes content-free Android notifications, suppresses a focused conversation and revokes logged out devices', async () => {
  const store = new MessagingStore(':memory:');
  const requests = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));
  const push = (store.push = new PushNotifications(
    store,
    { androidOrigins: new Set(['https://push.example.test']) },
    requests,
  ));
  try {
    const owner = store.createUser('human', 'notifyowner', 'Owner', 'hash');
    const agent = store.registerAgent(store.invite(owner.id).invitation, 'notifyagent', 'Agent').user;
    const { token } = store.issueSession(owner.id);
    const binding = randomUUID();
    const key = randomBytes(32).toString('base64url');
    const notice = (index: number) => {
      const value = String(requests.mock.calls[index][1]?.body);
      expect(value.startsWith('fable1.')).toBe(true);
      const bytes = Buffer.from(value.slice(7), 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from('fable-push-v1'));
      cipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString());
    };
    const cid = store.direct(owner.id, agent.id).id;
    expect(() =>
      push.subscribe(token, binding, { kind: 'android', endpoint: 'https://elsewhere.test/path', key }),
    ).toThrow('未配置');
    push.subscribe(token, binding, {
      kind: 'android',
      endpoint: 'https://push.example.test/up/private-route',
      key,
    });
    const marker = 'Never in the push notification';
    const first = store.send(agent.id, cid, 'same', marker);
    expect(store.send(agent.id, cid, 'same', marker).id).toBe(first.id);
    await push.run();
    expect(requests).toHaveBeenCalledTimes(1);
    const init = requests.mock.calls[0][1];
    expect(init?.redirect).toBe('error');
    expect(notice(0)).toMatchObject({
      binding,
      kind: 'message',
      conversation: cid,
      id: first.id,
    });
    expect(String(init?.body)).not.toContain(marker);
    push.focus(token, binding, cid);
    store.send(agent.id, cid, 'focused', 'No duplicate alert while viewing');
    await push.run();
    expect(requests).toHaveBeenCalledTimes(1);

    const calls = (store.calls = new CallStore(store));
    calls.ready(agent.id, true, true);
    const ringing = calls.create(agent.id, cid, randomUUID(), 'video');
    await push.run();
    expect(notice(1)).toMatchObject({
      kind: 'video-call',
      id: ringing.id,
      conversation: cid,
    });
    calls.update(owner.id, ringing.id, 'accept', 'hangup', 'first-session');
    expect(() => calls.update(owner.id, ringing.id, 'end', 'declined', 'second-session')).toThrow('另一台');
    await push.run();
    expect(notice(2)).toMatchObject({
      kind: 'call-cleared',
      id: ringing.id,
      conversation: cid,
    });
    store.logout(token);
    store.send(agent.id, cid, 'signedout', 'No notification after logout');
    await push.run();
    expect(requests).toHaveBeenCalledTimes(3);
  } finally {
    await push.close();
    store.close();
  }
});

it('encrypts browser push with VAPID and removes a permanently expired subscription', async () => {
  const store = new MessagingStore(':memory:');
  const ecdh = () => {
    const keys = createECDH('prime256v1');
    keys.generateKeys();
    return keys;
  };
  const issuer = ecdh(),
    browser = ecdh(),
    send = vi.fn<typeof fetch>(async () => new Response(null, { status: 410 }));
  const push = new PushNotifications(
    store,
    {
      web: {
        publicKey: issuer.getPublicKey().toString('base64url'),
        privateKey: issuer.getPrivateKey().toString('base64url'),
        subject: 'https://fablepavilion.example',
      },
      androidOrigins: new Set(),
    },
    send,
  );
  try {
    store.push = push;
    const owner = store.createUser('human', 'pushowner', 'Owner', 'hash');
    const agent = store.registerAgent(store.invite(owner.id).invitation, 'pushagent', 'Agent').user;
    const cid = store.direct(owner.id, agent.id).id;
    const { token } = store.issueSession(owner.id);
    const id = randomUUID(),
      keys = {
        p256dh: browser.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      };
    expect(() =>
      push.subscribe(token, id, {
        kind: 'web',
        endpoint: 'https://fcm.googleapis.com.example/fcm/send/fake',
        keys,
      }),
    ).toThrow('不支持');
    push.subscribe(token, id, {
      kind: 'web',
      endpoint: 'https://fcm.googleapis.com/fcm/send/testonly',
      keys,
    });
    store.send(agent.id, cid, 'opaque', 'Sensitive test only');
    await push.run();
    expect(send).toHaveBeenCalledTimes(1);
    const init = send.mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('authorization')).toMatch(/^vapid t=/);
    expect(String(init?.body)).not.toContain('Sensitive');
    expect(push.settings(token, id).registered).toBe(false);
  } finally {
    await push.close();
    store.close();
  }
});
