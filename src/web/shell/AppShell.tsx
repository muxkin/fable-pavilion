import { shallowRef, Suspense } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender } from '../render-effects';
import { useMessaging } from '../messaging/context';
import { Notice } from '../messaging/ui';
import { AccountForm } from '../messaging/AccountPages';
import { TrustedInvitationReceiver } from '../messaging/TrustedLogin';
import { readRoute, routeURL } from './routes';
import { useAppViewport } from './viewport';
import { lazyPage } from './lazy-page';
import { PageBoundary, PageLoading } from './PageBoundary';
import { takeLoginInvitation } from './login-invitation';

const AuthenticatedShell = lazyPage(() => import('./AuthenticatedShell'));

export const AppShell = tsxComponent(function AppShell() {
  useAppViewport();
  const routeRevision = shallowRef(0);
  const invitation = shallowRef<ReturnType<typeof takeLoginInvitation>>();
  const afterRender = watchRender();
  const watchRoute = watchRender();
  const session = useMessaging();
  const closeInvitation = () => {
    history.replaceState(history.state, '', routeURL({ page: 'messages' }));
    invitation.value = undefined;
    routeRevision.value++;
  };
  return () => {
    void routeRevision.value;
    const route = readRoute(new URL(location.href));
    afterRender(() => {
      window.dispatchEvent(new Event('pocket:app-ready'));
    }, []);
    watchRoute(() => {
      const pop = () => {
        routeRevision.value++;
      };
      window.addEventListener('popstate', pop);
      return () => window.removeEventListener('popstate', pop);
    }, []);
    if (session.loading && !session.user) return <PageLoading label="正在读取账户…" page={route.page} />;
    if (!session.user) {
      // Leave authenticated invitation links to the routed shell. Keep an anonymous
      // invitation in memory after removing its secret from the address bar.
      if (route.page === 'login-invite' && location.hash) invitation.value = takeLoginInvitation(route);
      return (
        <main class="workbench-onboarding pavilion-flow signed-out-entry">
          {route.page === 'login-invite' ? (
            <section class="pavilion-flow-content login-invite-content">
              <h1 class="pavilion-flow-title">登录邀请</h1>
              <TrustedInvitationReceiver
                key={invitation.value?.id ?? 'scan'}
                invitation={invitation.value}
                onCancel={closeInvitation}
                onLogin={(account) => {
                  session.setUser(account);
                  closeInvitation();
                }}
              />
            </section>
          ) : (
            <AccountForm />
          )}
          <div class="pavilion-flow-content workbench-account-secondary">
            <Notice text={session.connectionError} />
            {session.connectionError && (
              <button class="secondary" onClick={() => void session.refresh()}>
                重新连接
              </button>
            )}
          </div>
        </main>
      );
    }
    return (
      <PageBoundary
        page={route.page}
        backLabel="返回消息"
        onBack={() => location.replace(routeURL({ page: 'messages' }))}
      >
        {() => (
          <Suspense timeout={0}>
            {{
              fallback: () => <PageLoading page={route.page} />,
              default: () => <AuthenticatedShell key={session.user!.id} />,
            }}
          </Suspense>
        )}
      </PageBoundary>
    );
  };
});
