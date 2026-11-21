import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRelay } from '../src/server/relay.js';
import { parseAdminUserIds } from '../src/server/messaging/service-core.js';
import {
  MESSAGE_RETENTION_MS,
  SESSION_PERSISTENT_EXPIRES_AT,
} from '../src/server/messaging/store-core.js';
import { MessagingStore } from './messaging-fixtures.js';
import { TEST_TOTP_KEY, signedInDeviceFixture } from './secure-login-fixture.js';
import { AccountClient } from '../src/client/account.js';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import { mergeHistoryPages } from '../src/web/messaging/history-cache.js';
import {
  exportFilename,
  formatChatExportJson,
  formatChatExportMarkdown,
} from '../src/web/messaging/chat-export.js';
import type { ChatConversation, ChatMessage } from '../src/shared/messaging.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

async function adminRelayFixture(adminUids: string) {
  const devices = signedInDeviceFixture();
  cleanups.push(devices.dispose);
  const origin = 'https://chat.test';
  const relay = await buildRelay({
    origin,
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'test-admin-retention-relay-enrollment-secret',
    messaging: {
      humanContacts: true,
      totpKey: TEST_TOTP_KEY,
      adminUserIds: parseAdminUserIds(adminUids),
    },
  });
  cleanups.push(() => relay.app.close());
  class InjectClient extends EncryptedMessagingClient {
    override readonly account = devices.wrap(
      new AccountClient(<T>(path: string, method?: string, body?: unknown) =>
        this.raw<T>(path, method, body),
      ),
    );
    cookie = '';
    override async request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
      return this.raw<T>(path, method, payload);
    }
    override async raw<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
      const response = await relay.app.inject({
        method: method as 'GET',
        url: `/api/im${path}`,
        headers: {
          host: 'chat.test',
          origin,
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        payload: payload as object,
      });
      const nextCookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (nextCookie) this.cookie = nextCookie;
      const body = response.json();
      if (response.statusCode >= 400) throw Error(body.error ?? `HTTP ${response.statusCode}`);
      return body as T;
    }
  }
  const register = async (username: string, displayName: string) => {
    const client = new InjectClient();
    await client.account.register(username, displayName, 'Password!1234');
    return { client };
  };
  return { relay, register, origin };
}

describe('7-day cloud retention, persistent sessions, admin console, cache & export', () => {
  it('prunes cloud messages and files older than 7 days while preserving stickers, avatars and recent messages', () => {
    const store = new MessagingStore(':memory:', 'chat.test');
    cleanups.push(() => store.close());
    const alice = store.createUser('human', 'alice', 'Alice', 'hash');
    const bob = store.createUser('human', 'bob', 'Bob', 'hash');
    store.db
      .prepare('INSERT INTO im_contacts(user_id,contact_id) VALUES (?,?),(?,?)')
      .run(alice.id, bob.id, bob.id, alice.id);
    const convo = store.direct(alice.id, bob.id);
    const now = Date.now();
    const expiredAt = now - MESSAGE_RETENTION_MS - 60_000;
    const recentAt = now - 60_000;

    // Seed expired and recent messages + files + permanent sticker + permanent avatar.
    store.db
      .prepare(
        `INSERT INTO im_messages(id,conversation_id,sender_id,client_id,text,created_at,updated_at,request_fingerprint)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('11111111-1111-4111-8111-111111111111', convo.id, alice.id, 'old-1', 'old', expiredAt, expiredAt, 'fp1');
    store.db
      .prepare(
        `INSERT INTO im_messages(id,conversation_id,sender_id,client_id,text,created_at,updated_at,request_fingerprint)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('22222222-2222-4222-8222-222222222222', convo.id, alice.id, 'new-1', 'new', recentAt, recentAt, 'fp2');
    store.db
      .prepare(
        `INSERT INTO im_events(user_id,type,conversation_id,message_id) VALUES (?,'message',?,?)`,
      )
      .run(bob.id, convo.id, '11111111-1111-4111-8111-111111111111');
    store.db
      .prepare(
        `INSERT INTO im_files(id,conversation_id,user_id,message_id,name,mime,size,data,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        '33333333-3333-4333-8333-333333333333',
        convo.id,
        alice.id,
        '11111111-1111-4111-8111-111111111111',
        'old.bin',
        'application/octet-stream',
        4,
        Buffer.from('1234'),
        expiredAt,
      );
    store.db
      .prepare(
        `INSERT INTO im_files(id,conversation_id,user_id,message_id,name,mime,size,data,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        '44444444-4444-4444-8444-444444444444',
        convo.id,
        alice.id,
        '22222222-2222-4222-8222-222222222222',
        'new.bin',
        'application/octet-stream',
        4,
        Buffer.from('5678'),
        recentAt,
      );
    store.db
      .prepare(
        `INSERT INTO im_stickers(id,user_id,name,mime,size,data,source_id,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        '55555555-5555-4555-8555-555555555555',
        alice.id,
        'fav.webp',
        'image/webp',
        4,
        Buffer.from('webp'),
        '33333333-3333-4333-8333-333333333333',
        expiredAt - 30 * 86_400_000,
      );
    store.setAvatar(alice.id, Buffer.from('avatar'));

    const overviewBefore = store.adminOverview(now);
    expect(overviewBefore.messages.expiredPending).toBe(1);
    expect(overviewBefore.files.expiredPending).toBe(1);

    const pruned = store.pruneExpiredCloudData(now);
    expect(pruned).toEqual({ deletedMessages: 1, deletedFiles: 1 });

    // Recent message & file survive; expired ones are gone.
    expect(store.history(alice.id, convo.id).messages.map((m) => m.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(() => store.file(alice.id, convo.id, '33333333-3333-4333-8333-333333333333')).toThrow();
    expect(store.file(alice.id, convo.id, '44444444-4444-4444-8444-444444444444').name).toBe('new.bin');

    // Sync does not throw after expired messages are pruned.
    expect(() => store.sync(bob.id, 0)).not.toThrow();

    // Permanent stickers and avatars remain intact.
    expect(store.stickers(alice.id)).toHaveLength(1);
    expect(store.user(alice.id).avatarUrl).toBeTruthy();
  });

  it('issues persistent sessions and upgrades existing active sessions on touch', () => {
    const store = new MessagingStore(':memory:', 'chat.test');
    cleanups.push(() => store.close());
    const alice = store.createUser('human', 'alice', 'Alice', 'hash');
    const issued = store.issueSession(alice.id, { name: 'Linux · Chrome', verified: true });
    expect(issued.expiresAt).toBe(SESSION_PERSISTENT_EXPIRES_AT);

    // Simulate a legacy 30-day session and verify touchSession upgrades it to persistent.
    store.db
      .prepare('UPDATE im_sessions SET expires_at=? WHERE user_id=?')
      .run(Date.now() + 86_400_000, alice.id);
    store.touchSession(issued.token, { name: 'Linux · Chrome' }, true);
    const devices = store.loginDevices(alice.id, issued.token) as unknown as { expiresAt: number }[];
    expect(devices[0].expiresAt).toBe(SESSION_PERSISTENT_EXPIRES_AT);
  });

  it('enforces admin authorization and supports overview, user listing, session revocation and cleanup', async () => {
    const { register } = await adminRelayFixture('10000000');
    const admin = await register('adminuser', 'Admin');
    const regular = await register('normaluser', 'Regular');

    expect((await admin.client.me()).user?.isAdmin).toBe(true);
    expect((await regular.client.me()).user?.isAdmin).toBeUndefined();

    await expect(regular.client.request('/admin/overview')).rejects.toThrow('需要管理员权限');
    await expect(regular.client.request('/admin/users')).rejects.toThrow('需要管理员权限');
    await expect(regular.client.request('/admin/cleanup', 'POST', {})).rejects.toThrow('需要管理员权限');

    const overview = await admin.client.request<{
      retentionDays: number;
      users: { total: number; humans: number };
      sessions: { active: number };
    }>('/admin/overview');
    expect(overview.retentionDays).toBe(7);
    expect(overview.users.total).toBe(2);
    expect(overview.users.humans).toBe(2);
    expect(overview.sessions.active).toBe(2);

    const listed = await admin.client.request<{ users: { id: string; username: string }[] }>(
      '/admin/users?q=normal',
    );
    expect(listed.users.map((u) => u.username)).toEqual(['normaluser']);

    const revoked = await admin.client.request<{ revoked: number }>(
      `/admin/users/${listed.users[0].id}/revoke-sessions`,
      'POST',
      {},
    );
    expect(revoked.revoked).toBe(1);
    await expect(regular.client.me()).rejects.toThrow();

    const cleaned = await admin.client.request<{
      deletedMessages: number;
      deletedFiles: number;
      deletedObjects: number;
      overview: { dailyActivity: unknown[]; runtime?: string };
    }>('/admin/cleanup', 'POST', {});
    expect(cleaned.deletedMessages).toBe(0);
    expect(cleaned.deletedFiles).toBe(0);
    expect(cleaned.overview.dailyActivity).toHaveLength(7);

    // Rich endpoints: user detail, sessions, desktops, conversations, storage, audit
    const detail = await admin.client.request<{ user: { id: string }; sessions: unknown[]; desktops: unknown[] }>(
      `/admin/users/${listed.users[0].id}`,
    );
    expect(detail.user.id).toBe(listed.users[0].id);

    const sessions = await admin.client.request<{ sessions: { deviceId: string; current: boolean }[] }>(
      '/admin/sessions',
    );
    expect(sessions.sessions.some((s) => s.current)).toBe(true);

    const storage = await admin.client.request<{ retentionDays: number; topConsumers: unknown[] }>(
      '/admin/storage',
    );
    expect(storage.retentionDays).toBe(7);

    const conversations = await admin.client.request<{ conversations: unknown[] }>('/admin/conversations');
    expect(Array.isArray(conversations.conversations)).toBe(true);

    const desktops = await admin.client.request<{ desktops: unknown[] }>('/admin/desktops');
    expect(Array.isArray(desktops.desktops)).toBe(true);

    const audit = await admin.client.request<{ logs: { action: string }[] }>('/admin/audit');
    expect(audit.logs.some((l) => l.action === 'cleanup')).toBe(true);
    expect(audit.logs.some((l) => l.action === 'revoke_user_sessions')).toBe(true);

    // Zero-knowledge admin handoff auth flow (start -> inspect -> approve -> poll)
    const handoff = await admin.client.request<{ id: string; secret: string; code: string }>(
      '/admin/auth/start',
      'POST',
      {},
    );
    expect(handoff.code).toMatch(/^\d{6}$/);
    const inspected = await admin.client.request<{ approved: boolean; code: string }>(
      `/admin/auth/${handoff.id}`,
    );
    expect(inspected.approved).toBe(false);
    expect(inspected.code).toBe(handoff.code);

    const beforeApprove = await admin.client.request<{ pending: boolean }>('/admin/auth/poll', 'POST', {
      id: handoff.id,
      secret: handoff.secret,
    });
    expect(beforeApprove.pending).toBe(true);

    await admin.client.request('/admin/auth/approve', 'POST', { id: handoff.id, code: handoff.code });
    const afterApprove = await admin.client.request<{ pending: boolean; user?: { isAdmin?: boolean } }>(
      '/admin/auth/poll',
      'POST',
      { id: handoff.id, secret: handoff.secret },
    );
    expect(afterApprove.pending).toBe(false);
    expect(afterApprove.user?.isAdmin).toBe(true);
    // Single-use: polling again fails
    await expect(
      admin.client.request('/admin/auth/poll', 'POST', { id: handoff.id, secret: handoff.secret }),
    ).rejects.toThrow();

    // Admin delete user + migrate UID atomically with allocator reset
    await admin.client.request(`/admin/users/${listed.users[0].id}`, 'DELETE');
    const afterDelete = await admin.client.request<{ users: { id: string }[] }>('/admin/users');
    expect(afterDelete.users.map((u) => u.id)).toEqual(['10000000']);

    // Cannot delete self/admin
    await expect(admin.client.request('/admin/users/10000000', 'DELETE')).rejects.toThrow();

    // Register a second user (gets 10000002), delete old test slot if vacant, migrate to 10000001
    const third = await register('thirduser', 'Third');
    const thirdId = (await third.client.me()).user!.id;
    const migrated = await admin.client.request<{ fromId: string; toId: string; lastUid?: string }>(
      `/admin/users/${thirdId}/migrate-uid`,
      'POST',
      { toId: '10000001', resetAllocator: true },
    );
    expect(migrated.fromId).toBe(thirdId);
    expect(migrated.toId).toBe('10000001');
    expect(migrated.lastUid).toBe('10000001');
    expect((await third.client.me()).user?.id).toBe('10000001');
  });

  it('preserves older locally cached messages when merging newer cloud pages', () => {
    const mk = (seq: number, text: string, rev = 0): ChatMessage => ({
      id: `msg-${seq}`,
      sequence: seq,
      conversationId: 'c1',
      senderId: '10000000',
      sender: {
        id: '10000000',
        address: '10000000@chat.test',
        kind: 'human',
        username: 'alice',
        displayName: 'Alice',
        createdAt: 1,
      },
      clientId: `cid-${seq}`,
      text,
      createdAt: 1_700_000_000_000 + seq * 1000,
      updatedAt: 1_700_000_000_000 + seq * 1000,
      revision: rev,
      state: 'complete',
      attachments: [],
      mentions: [],
      replyTo: null,
    });
    const cached = { messages: [mk(1, '8天前的消息'), mk(2, '7天前的消息')] };
    // Server returns only a newer message (or empty after 7-day cloud prune).
    const afterEmpty = mergeHistoryPages(cached, { messages: [] });
    expect(afterEmpty.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);

    const afterNew = mergeHistoryPages(cached, { messages: [mk(2, '修订版', 1), mk(3, '今天的新消息')] });
    expect(afterNew.messages.map((m) => [m.id, m.text])).toEqual([
      ['msg-1', '8天前的消息'],
      ['msg-2', '修订版'],
      ['msg-3', '今天的新消息'],
    ]);
  });

  it('exports decrypted chat history to Markdown and JSON cleanly', () => {
    const convo: Pick<ChatConversation, 'id' | 'name' | 'kind' | 'members'> = {
      id: 'c1',
      name: '与测试助手的对话',
      kind: 'direct',
      members: [
        {
          id: '10000000',
          address: '10000000@chat.test',
          kind: 'human',
          username: 'alice',
          displayName: 'Alice',
          createdAt: 1,
          role: 'member',
          readSequence: 2,
        },
      ],
    };
    const msg: ChatMessage = {
      id: 'm1',
      sequence: 1,
      conversationId: 'c1',
      senderId: '10000000',
      sender: convo.members[0],
      clientId: 'cli-1',
      text: '你好，这是一条测试消息。',
      createdAt: Date.UTC(2026, 10, 20, 12, 30, 0),
      updatedAt: Date.UTC(2026, 10, 20, 12, 30, 0),
      revision: 0,
      state: 'complete',
      attachments: [
        {
          id: 'f1',
          name: 'report.pdf',
          mime: 'application/pdf',
          size: 2048,
          url: '/api/im/conversations/c1/files/f1/report.pdf',
        },
      ],
      mentions: [],
      replyTo: null,
    };

    const md = formatChatExportMarkdown(convo, [msg], Date.UTC(2026, 10, 21, 8, 0, 0));
    expect(md).toContain('# 与测试助手的对话');
    expect(md).toContain('Alice (@alice)');
    expect(md).toContain('你好，这是一条测试消息。');
    expect(md).toContain('report.pdf');

    const parsed = JSON.parse(formatChatExportJson(convo, [msg], Date.UTC(2026, 10, 21, 8, 0, 0)));
    expect(parsed.messageCount).toBe(1);
    expect(parsed.messages[0].text).toBe('你好，这是一条测试消息。');
    expect(exportFilename('测试/会话:名称', 'markdown', Date.UTC(2026, 10, 21, 8, 0, 0))).toMatch(
      /^测试_会话_名称-聊天记录-\d{8}-\d{4}\.md$/,
    );
  });
});
