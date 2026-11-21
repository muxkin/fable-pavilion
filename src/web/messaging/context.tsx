import {
  defineComponent,
  inject,
  onMounted,
  onScopeDispose,
  provide,
  shallowReactive,
  watch,
  type InjectionKey,
} from 'vue';
import { clearDrafts } from './drafts';
import { browserId } from '../browser-id';
import { MessagingError } from '../../client/messaging';
import { EncryptedMessagingClient } from '../../client/encrypted-messaging';
import type { ChatConversation, ChatContact, ChatMessage, ChatUser } from '../../shared/messaging';
import { awaitStartupStatus, takeStartupSession } from '../startup-session';
import { account, deviceLoginRequired } from './account-transport';
export { deviceLoginRequired } from './account-transport';
export const messaging = new EncryptedMessagingClient('', undefined, deviceLoginRequired, account);
interface MessagingState {
  humanContacts: boolean;
  user: ChatUser | null;
  loading: boolean;
  contacts: ChatContact[];
  conversations: ChatConversation[];
  revision: number;
  recovery: number;
  callRevision: number;
  updates: ChatMessage[];
  connectionError: string;
  setUser: (user: ChatUser | null) => void;
  updateProfile: (user: ChatUser) => void;
  refresh: () => Promise<void>;
}
const messagingKey: InjectionKey<MessagingState> = Symbol('messaging');
export const useMessaging = () => inject(messagingKey)!;

export const MessagingProvider = defineComponent({
  name: 'MessagingProvider',
  setup(_, { slots }) {
    const session = shallowReactive<MessagingState>({
      humanContacts: false,
      user: null,
      loading: true,
      contacts: [],
      conversations: [],
      revision: 0,
      recovery: 0,
      callRevision: 0,
      updates: [],
      connectionError: '',
      setUser: updateUser,
      updateProfile,
      refresh,
    });
    provide(messagingKey, session);
    let accountSession: typeof import('../account-session') | undefined;
    let media: typeof import('./media-cache') | undefined;
    let activationVersion = 0;
    async function activate(user: ChatUser | null) {
      const version = ++activationVersion;
      if (user && (!accountSession || !media)) {
        [accountSession, media] = await Promise.all([import('../account-session'), import('./media-cache')]);
        media.setEncryptedDownload((path, signal, cache, metadata) =>
          messaging.download(path, signal, cache, metadata),
        );
        if (version !== activationVersion) return false;
      }
      if (accountSession) await accountSession.activateAccount(messaging.account, user);
      else messaging.account.lock();
      if (version !== activationVersion) return false;
      media?.setMediaAccount(user?.id ?? null);
      return true;
    }
    async function refresh() {
      window.dispatchEvent(new Event('pocket-im-reconnect'));
      try {
        const readUser = () => messaging.me().then(({ user }) => user);
        const next = await (takeStartupSession()?.catch(readUser) ?? readUser());
        if (!next) await awaitStartupStatus();
        if (!(await activate(next))) return;
        session.user = next;
        session.connectionError = '';
      } catch (e) {
        if (e instanceof MessagingError && e.status === 401) {
          await awaitStartupStatus();
          if (await activate(null)) session.user = null;
        } else session.connectionError = '消息服务暂不可用，请检查连接后重试';
      } finally {
        session.loading = false;
      }
    }
    function updateUser(next: ChatUser | null) {
      session.loading = true;
      void activate(next)
        .then((active) => {
          if (!active) return;
          session.user = next;
          session.revision++;
        })
        .catch((e) => {
          session.user = next;
          session.connectionError = e instanceof Error ? e.message : '账号同步失败';
        })
        .finally(() => {
          session.loading = false;
        });
      try {
        localStorage.setItem('pocket-im-account-change', browserId());
      } catch {}
    }
    function updateProfile(next: ChatUser) {
      // Profile edits keep the unlocked session, mounted pages and drafts intact.
      if (session.user?.id === next.id) session.user = next;
      session.revision++;
    }
    const changed = (event: StorageEvent) => {
      if (event.key === 'pocket-im-account-change') void refresh();
    };
    onMounted(() => {
      window.addEventListener('storage', changed);
      void refresh();
    });
    onScopeDispose(() => {
      window.removeEventListener('storage', changed);
    });

    watch(
      [() => session.user?.id, () => session.user?.encrypted, () => session.loading],
      ([userId, encrypted, loading], _, onCleanup) => {
        media?.setMediaAccount(userId ?? null);
        clearDrafts();
        session.humanContacts = false;
        session.contacts = [];
        session.conversations = [];
        session.updates = [];
        if (!userId || loading) return;
        if (encrypted && !messaging.account.secrets) return;
        const abort = new AbortController(),
          signal = abort.signal;
        let request: AbortController | undefined, resumePause: (() => void) | undefined;
        const wake = () => {
          if (document.visibilityState === 'visible') {
            request?.abort();
            resumePause?.();
          }
        };
        window.addEventListener('online', wake);
        window.addEventListener('pocket-im-reconnect', wake);
        document.addEventListener('visibilitychange', wake);
        const pause = (ms: number) =>
          new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', finish);
              if (resumePause === finish) resumePause = undefined;
              resolve();
            };
            const timer = setTimeout(finish, ms);
            resumePause = finish;
            signal.addEventListener('abort', finish, { once: true });
          });
        void (async () => {
          let cursor: number | undefined,
            recovering = true;
          let failures = 0;
          while (!signal.aborted) {
            request = new AbortController();
            const requestSignal = AbortSignal.any([signal, request.signal]);
            try {
              if (recovering) {
                if (messaging.account.secrets)
                  await accountSession?.syncAccountHosts(messaging.account).catch(() => {});
                const state = await messaging.request<{
                  humanContacts?: boolean;
                  contacts: ChatContact[];
                  conversations: ChatConversation[];
                  cursor: number;
                }>('/bootstrap', 'GET', undefined, requestSignal);
                if (signal.aborted) return;
                session.humanContacts = state.humanContacts === true;
                session.contacts = state.contacts;
                session.conversations = state.conversations;
                media?.invalidateMediaConversations(new Set(state.conversations.map((c) => c.id)));
                const secrets = messaging.account.secrets;
                if (secrets && messaging.account.user?.id === userId) {
                  const lastChat = (() => {
                    try {
                      return sessionStorage.getItem(`pocket-last-chat:${userId}`);
                    } catch {
                      return null;
                    }
                  })();
                  const recent = state.conversations.slice(0, 4);
                  const last = lastChat && state.conversations.find(({ id }) => id === lastChat);
                  const warm = last
                    ? [last, ...recent.filter(({ id }) => id !== last.id)].slice(0, 4)
                    : recent;
                  void import('./history-cache')
                    .then(({ cachedHistory }) => {
                      if (signal.aborted) return;
                      for (const { id } of warm) void cachedHistory({ id: userId, secrets }, id);
                    })
                    .catch(() => {});
                }
                cursor ??= state.cursor;
                session.recovery++;
                session.callRevision++;
                recovering = false;
                session.connectionError = '';
              }
              const next = await messaging.sync(cursor!, 25000, requestSignal);
              if (signal.aborted) return;
              if (next.events.length) {
                if (next.events.some(({ type }) => type === 'call')) session.callRevision++;
                const messages = next.events.flatMap((e) => (e.message ? [e.message] : []));
                session.updates = Array.from(
                  new Map([...session.updates, ...messages].map((message) => [message.id, message])).values(),
                ).slice(-200);
                const [contacts, conversations] = await Promise.all([
                  messaging.contacts(requestSignal),
                  messaging.conversations(requestSignal),
                ]);
                if (signal.aborted) return;
                session.contacts = contacts.users;
                session.conversations = conversations.conversations;
                media?.invalidateMediaConversations(new Set(conversations.conversations.map((c) => c.id)));
                session.revision++;
                if (next.events.some((e) => e.type === 'profile')) {
                  const result = await messaging.me(requestSignal);
                  if (!signal.aborted) session.user = result.user;
                }
              }
              cursor = next.cursor;
              failures = 0;
              session.connectionError = '';
            } catch (e) {
              if (signal.aborted) return;
              if (request.signal.aborted) {
                recovering = true;
                continue;
              }
              if (e instanceof MessagingError && e.status === 401) {
                if (await activate(null)) session.user = null;
                return;
              }
              failures++;
              if (!navigator.onLine) session.connectionError = '当前离线，联网后会自动补齐消息';
              else if (failures >= 2) session.connectionError = '正在恢复消息同步，已有记录仍可查看';
              recovering = true;
              await pause(Math.min(1000 * 2 ** (failures - 1), 10000));
            } finally {
              // Release combined-signal listeners as soon as this polling cycle finishes.
              request.abort();
            }
          }
        })();
        onCleanup(() => {
          abort.abort();
          window.removeEventListener('online', wake);
          window.removeEventListener('pocket-im-reconnect', wake);
          document.removeEventListener('visibilitychange', wake);
        });
      },
      { immediate: true, flush: 'post' },
    );

    return () => slots.default?.();
  },
});
