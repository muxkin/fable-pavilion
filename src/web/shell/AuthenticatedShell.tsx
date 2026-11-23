import { tsxComponent } from '../tsx-component';
import { onMounted, onScopeDispose, shallowRef, Suspense } from 'vue';
import { useExternalSnapshot, watchRender, writeRef } from '../render-effects';
import { useMessaging } from '../messaging/context';
import { BackendChooser } from '../BackendChooser';
import { DEFAULT_BACKEND } from '../../shared/backends';
import { TERMINAL_BACKEND_ID } from '../../shared/plugins';
import { deviceSession } from '../device-session';
import type { PairedHost } from '../sync-store';
import { Icon } from '../Icon';
import SelectionTranslation from '../SelectionTranslation.vue';
import { modules, workspaceTools } from './modules';
import {
  backDestination,
  backTo,
  mobileParents,
  previousHistoryRoute,
  readRoute,
  routeURL,
  type AppRoute,
} from './routes';
import { afterDialogs, handleDialogBack, usesMobileHistory } from './dialog-history';
import { rememberWorkbenchDevice } from './workbench-recency';
import { lazyPage as lazy } from './lazy-page';
const AgentWorkspace = lazy(workspaceTools[0].load);
const TerminalWorkspace = lazy(() => import('../terminal/TerminalWorkspace'));
const MessagingPages = lazy(() => import('../messaging/MessagingPages'));
import MePages from './MePages';
import { useSoftwareUpdates } from './software-updates';
import { hasMessagingDrafts, subscribeDrafts } from '../messaging/drafts';
import { PageBoundary, PageLoading } from './PageBoundary';
import { AccountSecurity } from '../messaging/AccountSecurity';
import { TrustedInvitationReceiver } from '../messaging/TrustedLogin';
import { AdminAuthApproval, takeAdminAuthParams } from '../messaging/AdminAuthApproval';
import { onAccountSessionChange, syncAccountHosts, accountSyncError } from '../account-session';
import { messaging } from '../messaging/context';
import { DesktopAuthorizationPage, readDesktopAuthorization } from './DesktopAuthorizationPage';
import { Avatar } from '../messaging/ui';
import { IncomingAgentCalls } from '../messaging/AgentCall';
import {
  clearStaleNotificationAccount,
  watchAndroidRegistration,
  watchNotificationFocus,
} from '../notifications';
import { notificationId } from '../../shared/notifications';
import TrustedLoginNotice from '../messaging/TrustedLoginNotice.vue';
import WebsiteUpdateNotice from './WebsiteUpdateNotice.vue';
import { takeLoginInvitation } from './login-invitation';
import { ComputerSetup } from './ComputerSetup';

import { startAdapterKeybookSync } from '../adapter-keybook-sync';
import '../styles/workspace.css';

const isWorkbenchHome = (route: AppRoute) =>
  route.page === 'workbench' && !route.backend && !route.thread && !route.host;

const isModuleRoot = (route: AppRoute) =>
  isWorkbenchHome(route) ||
  (route.page === 'messages' && !route.conversation) ||
  (route.page === 'contacts' && !route.contact) ||
  route.page === 'me';

function seedMobileHistory(route: AppRoute) {
  if (
    !usesMobileHistory() ||
    location.hash ||
    history.state?.pocketDialogs?.length ||
    typeof history.state?.pocketDepth === 'number'
  )
    return;
  const entries = [...mobileParents(route), route];
  history.replaceState({ pocket: true, pocketDepth: 0 }, '', routeURL(entries[0]));
  for (let depth = 1; depth < entries.length; depth++) {
    history.pushState(
      { pocket: true, pocketDepth: depth, previousRoute: routeURL(entries[depth - 1]) },
      '',
      routeURL(entries[depth]),
    );
  }
}

export default tsxComponent(function AuthenticatedShell() {
  let stopKeybookSync: (() => void) | undefined;
  onMounted(() => {
    stopKeybookSync = startAdapterKeybookSync(messaging.account, messaging.raw.bind(messaging));
  });
  onScopeDispose(() => stopKeybookSync?.());
  const adminAuthRequest = shallowRef(takeAdminAuthParams());
  const routeState = shallowRef(readRoute(new URL(location.href)));
  const pairingLinkRevision = shallowRef(0);
  seedMobileHistory(routeState.value);
  const loginInvitation = shallowRef(takeLoginInvitation(routeState.value));
  const setRoute = writeRef(routeState);
  let desktopRequest =
    routeState.value.page === 'desktop-authorization' ? readDesktopAuthorization(location.hash) : undefined;
  if (routeState.value.page === 'desktop-authorization' && location.hash)
    history.replaceState(history.state, '', location.pathname + location.search);
  const workbenchRoute: { current: AppRoute } = {
    current: routeState.value.page === 'workbench' ? routeState.value : { page: 'workbench' },
  };
  const lastChat: { current: { account: string; id: string } | undefined } = { current: undefined };
  const readyState = shallowRef(false);
  const setReady = writeRef(readyState);
  const hostSnapshot = shallowRef<{
    scope: string;
    hosts: PairedHost[];
    hostId: string;
    storageError?: true;
  }>();
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const workbenchUpdateBlocked = shallowRef(false);
  const setWorkbenchUpdateBlocked = writeRef(workbenchUpdateBlocked);
  const messagingUpdateBlocked = useExternalSnapshot(subscribeDrafts, hasMessagingDrafts);
  const readSoftwareUpdates = useSoftwareUpdates();
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const workspaceVisitedState = shallowRef(
    routeState.value.page === 'workbench' || routeState.value.page === 'pair',
  );
  const setWorkspaceVisited = writeRef(workspaceVisitedState);
  let rootNavigation: AppRoute | undefined;
  const navigate = (target: AppRoute, replace = false) =>
    afterDialogs(() => {
      let next = target;
      if (next.page !== 'login-invite') loginInvitation.value = undefined;
      if (next.page === 'workbench' && (next.backend || next.thread) && !next.host)
        next = { ...next, host: deviceSession.host?.hostId };
      if (rootNavigation) {
        rootNavigation = next;
        return;
      }
      if (next.page === 'workbench' && !isWorkbenchHome(next)) workbenchRoute.current = next;
      const nextURL = routeURL(next);
      if (nextURL !== location.pathname + location.search) {
        const current = routeState.value;
        const currentURL = routeURL(current);
        const mobile = usesMobileHistory();
        const depth = history.state?.pocketDepth;
        let pocketDepth = typeof depth === 'number' ? depth : 0;
        const replaceEntry = replace || nextURL === currentURL;
        const rebuild = mobile && (typeof depth !== 'number' || current.page === 'pair');
        const parents = mobile && (!replaceEntry || rebuild) ? mobileParents(next, current) : [];
        const root = mobile && (isModuleRoot(next) ? next : parents.find(isModuleRoot));
        if (root && pocketDepth > 0) {
          rootNavigation = next;
          history.go(-pocketDepth);
          return;
        }
        if (root) history.replaceState({ pocket: true, pocketDepth: 0 }, '', routeURL(root));
        if (!root || !isModuleRoot(next)) {
          let previousRoute = root
            ? routeURL(root)
            : replaceEntry
              ? history.state?.previousRoute
              : currentURL;
          for (const parent of parents) {
            const url = routeURL(parent);
            if (url === previousRoute) continue;
            history.pushState({ pocket: true, previousRoute, pocketDepth: ++pocketDepth }, '', url);
            previousRoute = url;
          }
          const push = !replaceEntry || !!root;
          if (mobile && push) pocketDepth++;
          history[push ? 'pushState' : 'replaceState'](
            { pocket: true, previousRoute, ...(mobile ? { pocketDepth } : {}) },
            '',
            nextURL,
          );
        }
      }
      setRoute(next);
      if (next.page === 'workbench' || next.page === 'pair') setWorkspaceVisited(true);
    });
  let hostRefresh = 0;
  const refreshHosts = async () => {
    const refresh = ++hostRefresh;
    const scope = deviceSession.cache.scope;
    const current = () => refresh === hostRefresh && scope === deviceSession.cache.scope;
    const hostId = () => deviceSession.host?.hostId ?? '';
    try {
      const hosts = await deviceSession.cache.hosts(scope);
      if (current()) hostSnapshot.value = { scope, hosts, hostId: hostId() };
    } catch (error) {
      if (current()) {
        const hosts = hostSnapshot.value?.scope === scope ? hostSnapshot.value.hosts : [];
        hostSnapshot.value = { scope, hosts, hostId: hostId(), storageError: true };
      }
      throw error;
    }
  };
  const selectedBackendState = shallowRef(deviceSession.backendId);
  const setSelectedBackend = writeRef(selectedBackendState);
  const watchItem = watchRender();
  const watchRoute = watchRender();
  const watchError = watchRender();
  const watchInterval = watchRender();
  const watchRoute2 = watchRender();
  const watchSelectedBackend = watchRender();
  const watchWorkspaceHost = watchRender();
  const workspaceHostRetry = shallowRef(0);
  const workspaceHostError = shallowRef('');
  const watchWorkbenchLogin = watchRender();
  const watchNotifications = watchRender();
  const watchAndroidPush = watchRender();
  const watchNotificationRoute = watchRender();
  return () => {
    const { conversations, loading: accountLoading, connectionError, setUser, user } = useMessaging();
    const unread = conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
    const route = routeState.value;
    const software = readSoftwareUpdates(route.page === 'downloads');
    const hasUpdate = software.website || software.androidAvailable;

    const accountId = user?.id;
    const ready = readyState.value;
    const matchingScope = hostSnapshot.value?.scope === (accountId ?? '') ? hostSnapshot.value : undefined;
    const hosts = matchingScope?.hosts ?? [];
    const hostId = matchingScope?.hostId ?? '';
    const pairingStorageError = matchingScope?.storageError === true;
    const busy = busyState.value;
    const error = errorState.value;
    const workspaceVisited = workspaceVisitedState.value;
    watchNotifications(() => {
      if (accountLoading) return;
      if (!connectionError) clearStaleNotificationAccount(accountId);
      if (accountId)
        return watchNotificationFocus(accountId, route.page === 'messages' ? route.conversation : undefined);
    }, [accountId, accountLoading, connectionError, route.page, route.conversation]);
    watchAndroidPush(() => watchAndroidRegistration(accountId), [accountId]);
    watchNotificationRoute(() => {
      const open = (event: MessageEvent) => {
        const { type, conversation } = event.data ?? {};
        if (type === 'fable-open-notification' && notificationId.test(conversation))
          navigate({ page: 'messages', conversation });
      };
      navigator.serviceWorker?.addEventListener('message', open);
      return () => navigator.serviceWorker?.removeEventListener('message', open);
    }, []);

    watchItem(() => {
      if (
        accountId &&
        route.page === 'messages' &&
        route.conversation &&
        conversations.some(({ id }) => id === route.conversation)
      ) {
        lastChat.current = { account: accountId, id: route.conversation };
        try {
          sessionStorage.setItem(`pocket-last-chat:${accountId}`, route.conversation);
        } catch {}
      }
    }, [accountId, route.page, route.conversation, conversations]);
    function resumeMessages(): AppRoute {
      let id = lastChat.current?.account === accountId ? lastChat.current?.id : undefined;
      if (accountId && !id) {
        try {
          id = sessionStorage.getItem(`pocket-last-chat:${accountId}`) ?? undefined;
        } catch {}
      }
      return id && conversations.some((chat) => chat.id === id)
        ? { page: 'messages', conversation: id }
        : { page: 'messages' };
    }
    watchRoute(() => {
      const pop = () => {
        handleDialogBack();
        const next = readRoute(new URL(location.href));
        if (
          usesMobileHistory() &&
          isModuleRoot(routeState.value) &&
          history.state?.pocket &&
          typeof history.state.pocketDepth !== 'number'
        ) {
          // Older builds stacked tab selections under the root. Consume those entries.
          history.back();
          return;
        }
        if (rootNavigation) {
          const target = rootNavigation;
          rootNavigation = undefined;
          setRoute(next);
          navigate(target);
          return;
        }
        if (!location.hash && routeURL(next) === routeURL(routeState.value)) return;
        if (next.page === 'pair' && location.hash) pairingLinkRevision.value++;
        loginInvitation.value = takeLoginInvitation(next);
        if (next.page === 'workbench' && !isWorkbenchHome(next)) workbenchRoute.current = next;
        setRoute(next);
        if (next.page === 'workbench' || next.page === 'pair') setWorkspaceVisited(true);
      };
      window.addEventListener('popstate', pop);
      handleDialogBack();
      return () => window.removeEventListener('popstate', pop);
    }, []);

    watchError(() => {
      if (accountLoading) return;
      let alive = true;
      const refresh = () => refreshHosts().catch(() => {});
      const stopAccountUpdates = onAccountSessionChange(() => void refresh());
      const stopDeviceUpdates = deviceSession.onChange(() => void refresh());
      void refresh().finally(() => {
        if (alive) setReady(true);
      });
      void deviceSession
        .init()
        .then(refresh)
        .catch(() => {});
      return () => {
        alive = false;
        stopAccountUpdates();
        stopDeviceUpdates();
      };
    }, [refreshHosts, accountLoading, user?.id]);
    watchInterval(() => {
      if (!user?.encrypted) return;
      const sync = () => {
        if (document.visibilityState !== 'hidden')
          void syncAccountHosts(messaging.account)
            .then(refreshHosts)
            .catch(() => {});
      };
      const timer = setInterval(sync, 30000);
      window.addEventListener('focus', sync);
      return () => {
        clearInterval(timer);
        window.removeEventListener('focus', sync);
      };
    }, [user?.id, user?.encrypted, refreshHosts]);
    watchRoute2(() => {
      if (ready && route.page !== 'pair') void deviceSession.init().catch(() => {});
    }, [route.page, ready]);
    const chooser = isWorkbenchHome(route);
    const devices = route.page === 'devices';
    const setup = route.page === 'add-computer' || route.page === 'account-login';
    watchWorkbenchLogin(() => {
      if (route.page === 'account-login' && user && !accountLoading) navigate({ page: 'workbench' }, true);
    }, [route.page, accountId, accountLoading]);
    const workspaceRoute =
      (route.page === 'workbench' && !chooser) || route.page === 'pair' ? route : workbenchRoute.current;
    const backendId = workspaceRoute.backend ?? DEFAULT_BACKEND;
    const selectedBackend = selectedBackendState.value;
    watchSelectedBackend(() => {
      deviceSession.selectBackend(backendId);
      setSelectedBackend(backendId);
    }, [backendId]);
    const activeWorkspace = route.page === 'workbench' || route.page === 'pair';
    const showWorkspace = activeWorkspace && !chooser;
    const requestedHost = workspaceRoute.page === 'workbench' ? workspaceRoute.host : undefined;
    const matchingHost = !requestedHost || requestedHost === hostId;
    const requestedPair = hosts.find((host) => host.hostId === requestedHost);
    watchWorkspaceHost(() => {
      workspaceHostError.value = '';
      if (!ready || !showWorkspace || route.page !== 'workbench') return;
      if (matchingHost) {
        if (hostId) rememberWorkbenchDevice(accountId ?? '', hostId, hosts);
        return;
      }
      if (!requestedPair || pairingStorageError) return;
      const scope = deviceSession.cache.scope;
      if (scope !== (accountId ?? '')) return;
      let alive = true;
      const reportFailure = (message: string) => {
        if (alive && scope === deviceSession.cache.scope && deviceSession.host?.hostId !== requestedHost)
          workspaceHostError.value = message;
      };
      const timer = setTimeout(() => reportFailure('打开这台电脑超时，可重试。'), 10000);
      void deviceSession.select(requestedPair, false)
        .catch(() => reportFailure('无法打开这台电脑，可重试。'))
        .finally(() => clearTimeout(timer));
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [
      ready, showWorkspace, route.page, requestedHost, hostId, matchingHost, !!requestedPair,
      pairingStorageError, accountId, workspaceHostRetry.value,
    ]);
    const root =
      ['messages', 'contacts', 'workbench', 'me'].includes(route.page) &&
      !route.thread &&
      !route.conversation &&
      !route.contact;
    const messagingPage = ['messages', 'contacts', 'profile', 'integrations'].includes(route.page);
    const showNavigation = route.page !== 'pair';
    const activeModule = setup
      ? 'workbench'
      : route.page === 'messages' || route.page === 'contacts' || route.page === 'workbench'
        ? route.page
        : route.page === 'integrations'
          ? (route.from ?? 'contacts')
          : 'me';
    const back = () => backTo(backDestination(route, previousHistoryRoute()), navigate);
    const openModule = (page: (typeof modules)[number]['id']) =>
      navigate(page === 'messages' ? (route.page === 'messages' ? route : resumeMessages()) : { page });
    if (route.page === 'login-invite') {
      const close = () => navigate({ page: 'messages' }, true);
      return (
        <main class="workbench-onboarding pavilion-flow">
          <section class="pavilion-flow-content login-invite-content">
            <h1 class="pavilion-flow-title">登录邀请</h1>
            {accountLoading ? (
              <PageLoading page={route.page} />
            ) : user ? (
              <>
                <p class="pavilion-flow-description">
                  此浏览器已经登录。请在新设备或未登录的浏览器打开邀请。
                </p>
                <button class="secondary" onClick={close}>
                  返回消息
                </button>
              </>
            ) : (
              <TrustedInvitationReceiver
                key={loginInvitation.value?.id ?? 'scan'}
                invitation={loginInvitation.value}
                onCancel={close}
                onLogin={(account) => {
                  setUser(account);
                  close();
                }}
              />
            )}
          </section>
        </main>
      );
    }
    if (route.page === 'desktop-authorization') {
      return (
        <AccountSecurity>
          {() => (
            <DesktopAuthorizationPage
              request={desktopRequest}
              finish={() => {
                desktopRequest = undefined;
                navigate({ page: 'workbench' }, true);
              }}
            />
          )}
        </AccountSecurity>
      );
    }
    return (
      <AccountSecurity>
        {() => (
          <>
            <div
              class={`app-shell ${root ? 'shell-root' : 'shell-detail'} ${showNavigation ? 'has-navigation' : ''}`}
            >
              <div class="shell-content">
                {ready && (chooser || devices) && (
                  <BackendChooser
                    key={accountId ?? 'local'}
                    hosts={hosts}
                    pairingStorageError={pairingStorageError}
                    busy={busy}
                    navigate={navigate}
                    refreshHosts={refreshHosts}
                    manage={devices}
                    back={back}
                  />
                )}
                {setup && (
                  <ComputerSetup
                    key={route.page}
                    accountLogin={route.page === 'account-login'}
                    navigate={navigate}
                    back={back}
                  />
                )}
                {ready && showWorkspace && !matchingHost && (
                  <section class="module-empty" role="status">
                    <p>
                      {pairingStorageError
                        ? '浏览器暂时无法读取这台电脑的本机配对记录。'
                        : requestedPair
                          ? workspaceHostError.value || '正在打开电脑…'
                          : '这台电脑已移除或尚未配对。'}
                    </p>
                    {(workspaceHostError.value || pairingStorageError) && (
                      <button class="secondary" onClick={() => {
                        if (pairingStorageError) void refreshHosts().catch(() => {});
                        else workspaceHostRetry.value++;
                      }}>
                        重试
                      </button>
                    )}
                    <button class="secondary" onClick={() => navigate({ page: 'workbench' })}>
                      返回工作台
                    </button>
                  </section>
                )}
                {ready &&
                  workspaceVisited &&
                  !isWorkbenchHome(workspaceRoute) &&
                  matchingHost &&
                  selectedBackend === backendId && (
                    <section class="workspace-module" hidden={!showWorkspace} aria-label="工作台模块">
                      <Suspense timeout={0}>
                        {{
                          fallback: () => <PageLoading label="正在打开工作台…" page="workbench" />,
                          default: () => (
                            <>
                              <PageBoundary
                                page="workbench"
                                backLabel="返回消息"
                                onBack={() => navigate(resumeMessages())}
                              >
                                {() => (
                                  <>
                                    {backendId === TERMINAL_BACKEND_ID ? (
                                      <TerminalWorkspace
                                        key={`${hostId || 'unpaired'}:${backendId}`}
                                        active={showWorkspace}
                                        route={workspaceRoute}
                                        navigate={navigate}
                                      />
                                    ) : (
                                      <AgentWorkspace
                                        key={workspaceRoute.page === 'pair'
                                          ? `pair:${pairingLinkRevision.value}`
                                          : `${hostId || 'unpaired'}:${backendId}`}
                                        active={showWorkspace}
                                        route={workspaceRoute}
                                        navigate={navigate}
                                        onBusy={setBusy}
                                        onUpdateBlocked={setWorkbenchUpdateBlocked}
                                      />
                                    )}
                                  </>
                                )}
                              </PageBoundary>
                            </>
                          ),
                        }}
                      </Suspense>
                    </section>
                  )}
                {activeWorkspace && !ready && (
                  <div class="page-loading" role="status">
                    正在打开…
                  </div>
                )}
                {route.page === 'pair' && (
                  <button class="pair-back icon-button" aria-label="返回" onClick={back}>
                    <Icon name="back" />
                  </button>
                )}
                {messagingPage && (
                  <Suspense timeout={0}>
                    {{
                      fallback: () => <PageLoading page={route.page} />,
                      default: () => (
                        <>
                          <PageBoundary
                            key={route.page}
                            page={route.page}
                            backLabel="返回工作台"
                            onBack={() => navigate({ page: 'workbench' })}
                          >
                            {() => (
                              <>
                                <MessagingPages route={route} navigate={navigate} />
                              </>
                            )}
                          </PageBoundary>
                        </>
                      ),
                    }}
                  </Suspense>
                )}
                {!activeWorkspace && !messagingPage && !devices && !setup && (
                  <Suspense timeout={0}>
                    {{
                      fallback: () => <PageLoading page={route.page} />,
                      default: () => (
                        <>
                          <PageBoundary
                            key={route.page}
                            page={route.page}
                            backLabel="返回工作台"
                            onBack={() => navigate({ page: 'workbench' })}
                          >
                            {() => (
                              <>
                                <MePages
                                  route={route}
                                  navigate={navigate}
                                  back={back}
                                  software={software}
                                  updateBlocked={workbenchUpdateBlocked.value || messagingUpdateBlocked.value}
                                />
                              </>
                            )}
                          </PageBoundary>
                        </>
                      ),
                    }}
                  </Suspense>
                )}
                {error && (activeWorkspace || route.page === 'devices') && (
                  <p class="shell-error" role="alert">
                    {error}
                  </p>
                )}
                {accountSyncError && (
                  <p class="shell-error" role="status">
                    {accountSyncError}
                  </p>
                )}
                <WebsiteUpdateNotice
                  available={software.website}
                  buildId={software.websiteBuildId}
                  blocked={workbenchUpdateBlocked.value || messagingUpdateBlocked.value}
                  hidden={route.page === 'downloads'}
                />
                {user && <TrustedLoginNotice openSecurity={() => navigate({ page: 'login-security' })} />}
                {user && adminAuthRequest.value && (
                  <AdminAuthApproval
                    key={`${user.id}:${adminAuthRequest.value.id}`}
                    request={adminAuthRequest.value}
                    onClose={() => (adminAuthRequest.value = null)}
                  />
                )}
                {user && <IncomingAgentCalls key={user.id} />}
              </div>
              {ready && (showWorkspace || (route.page === 'messages' && route.conversation)) && (
                <SelectionTranslation key={JSON.stringify([accountId, hostId, routeURL(route)])} />
              )}
              {showNavigation && (
                <nav class="bottom-navigation" aria-label="主要功能">
                  {modules.map((module) => (
                    <button
                      key={module.id}
                      aria-current={activeModule === module.id ? 'page' : undefined}
                      onClick={() => openModule(module.id)}
                    >
                      {module.id === 'me' && user ? (
                        <Avatar user={user} />
                      ) : (
                        <Icon name={module.icon} size={24} />
                      )}
                      <span>{module.title}</span>
                      {module.id === 'me' && hasUpdate && <i class="navigation-update" aria-hidden="true" />}
                      {module.id === 'messages' && unread > 0 && (
                        <b class="navigation-unread" aria-hidden="true">
                          {unread > 99 ? '99+' : unread}
                        </b>
                      )}
                    </button>
                  ))}
                </nav>
              )}
            </div>
          </>
        )}
      </AccountSecurity>
    );
  };
});
