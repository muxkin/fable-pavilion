import { tsxComponent } from '../tsx-component';
import { PageHeader } from '../shell/PageHeader';
import { backTo, parentRoute, type AppRoute } from '../shell/routes';
import { AccountForm } from './AccountPages';
import { Agents, Profile } from './ProfilePages';
import ContactsPage from './ContactsPage';
import MessagesPage from './MessagesPage';
import { useMessaging } from './context';
import { Notice, type Navigate } from './ui';
import './messaging.css';
import './input-tools.css';
export default tsxComponent(function MessagingPages(_props: { route: AppRoute; navigate: Navigate }) {
  return ({ route, navigate }) => {
    const { user, loading, connectionError, refresh } = useMessaging();
    if (loading)
      return (
        <main class="module-page">
          <div class="page-loading" role="status">
            正在读取账户…
          </div>
        </main>
      );
    if (!user)
      return (
        <main class="module-page pavilion-flow">
          {(route.page === 'profile' || route.page === 'integrations' || route.conversation) && (
            <PageHeader
              title={
                route.page === 'profile' ? '个人资料' : route.page === 'integrations' ? 'Agent 接入' : '消息'
              }
              back={() => backTo(parentRoute(route), navigate)}
            />
          )}
          <AccountForm />
          {connectionError && (
            <div class="pavilion-flow-content account-entry-retry">
              <Notice text={connectionError} />
              <button class="secondary" onClick={() => void refresh()}>
                重新连接
              </button>
            </div>
          )}
        </main>
      );
    return (
      <main
        class={`module-page im-page ${route.page === 'messages' || route.page === 'contacts' ? 'im-wide' : ''}`}
      >
        <div class="im-page-body">
          {route.page === 'profile' ? (
            <Profile navigate={navigate} />
          ) : route.page === 'integrations' ? (
            <Agents navigate={navigate} back={() => backTo(parentRoute(route), navigate)} />
          ) : route.page === 'contacts' ? (
            <ContactsPage navigate={navigate} selected={route.contact} />
          ) : (
            <MessagesPage id={route.conversation} navigate={navigate} />
          )}
        </div>
        {connectionError && (
          <div class="im-connection-notice" role="status">
            <span>{connectionError}</span>
            <button onClick={() => void refresh()}>重新连接</button>
          </div>
        )}
      </main>
    );
  };
});
