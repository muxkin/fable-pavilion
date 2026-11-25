import { Icon } from '../Icon';
import { AccountForm } from '../messaging/AccountPages';
import { useMessaging } from '../messaging/context';
import { Notice } from '../messaging/ui';
import { tsxComponent } from '../tsx-component';
import { PageHeader } from './PageHeader';
import type { AppRoute } from './routes';

type Navigate = (route: AppRoute) => void;

export const OtherConnectionMethods = tsxComponent(function OtherConnectionMethods(_props: {
  navigate: Navigate;
}) {
  return ({ navigate }) => (
    <details class="workbench-other-connection">
      <summary>
        <Icon name="chevron" size={17} />
        其他连接方式
      </summary>
      <button type="button" class="secondary" onClick={() => navigate({ page: 'pair' })}>
        扫码或输入配对码
      </button>
    </details>
  );
});

export const WorkbenchAccountAccess = tsxComponent(function WorkbenchAccountAccess(_props: {
  navigate: Navigate;
}) {
  return () => {
    const { connectionError, refresh } = useMessaging();
    return (
      <div class="workbench-account-access">
        <AccountForm />
        <div class="pavilion-flow-content workbench-account-secondary">
          <Notice text={connectionError} />
          {connectionError && (
            <button class="secondary" onClick={() => void refresh()}>
              重新连接
            </button>
          )}
        </div>
      </div>
    );
  };
});

export const ComputerSetupGuide = tsxComponent(function ComputerSetupGuide(_props: {
  title: string;
  navigate: Navigate;
}) {
  return ({ title, navigate }) => (
    <section class="pavilion-flow-content workbench-setup-content" aria-labelledby="computer-setup-title">
      <Icon name="monitor" size={88} style={{ strokeWidth: 0.95 }} />
      <h2 id="computer-setup-title" class="pavilion-flow-title">
        {title}
      </h2>
      <p class="pavilion-flow-description">在电脑上打开子虚亭适配器，登录同一账号后确认授权。</p>
      <button class="primary workbench-download" onClick={() => navigate({ page: 'downloads' })}>
        <Icon name="download" size={22} />
        下载电脑适配器
      </button>
    </section>
  );
});

export const ComputerSetup = tsxComponent(function ComputerSetup(_props: {
  accountLogin: boolean;
  navigate: Navigate;
  back: () => void;
}) {
  return ({ accountLogin, navigate, back }) => {
    const { user } = useMessaging();
    return (
      <main class="workbench-onboarding pavilion-flow">
        <PageHeader title={accountLogin ? '工作台' : '添加电脑'} back={back} />
        {user && !accountLogin ? (
          <ComputerSetupGuide title="连接电脑" navigate={navigate} />
        ) : !user ? (
          <WorkbenchAccountAccess navigate={navigate} />
        ) : (
          <p class="page-loading" role="status">
            正在打开工作台…
          </p>
        )}
      </main>
    );
  };
});
