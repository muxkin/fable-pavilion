import { tsxComponent } from '../tsx-component';
import { shallowRef, Suspense, type VNodeChild } from 'vue';
import { watchRender, writeRef } from '../render-effects';
import type { IconName } from '../icon-paths';

import { messaging, useMessaging } from '../messaging/context';
import { Avatar } from '../messaging/ui';
import { AccountForm } from '../messaging/AccountPages';
import { deviceSession } from '../device-session';
import { downloadDiagnostics } from '../diagnostics';
import { usePwaInstall } from '../pwa-install';
import BrandIcon from '../theme/BrandIcon.vue';
import { Icon } from '../Icon';
import { PageHeader } from './PageHeader';
import type { AppRoute } from './routes';
import type { AndroidRelease, AndroidUpdateState } from './software-updates';
import { NotificationSettings } from '../messaging/NotificationSettings';
import { lazyPage as lazy } from './lazy-page';
import './settings-hierarchy.css';
const DownloadsPage = lazy(() => import('./DownloadsPage.vue'));
const DonationPage = lazy(() => import('./DonationPage.vue'));
const AppearanceSettings = lazy(() => import('../theme/AppearanceSettings.vue'));
const PluginSettings = lazy(() => import('../PluginSettings'));
const LoginSecurity = lazy(() => import('../messaging/LoginSecurity'));
const AccountCredentials = lazy(() => import('../messaging/AccountCredentials'));
const ResourceSettings = lazy(() => import('../messaging/ResourceSettings'));

const Row = tsxComponent(function Row(_props: {
  icon: IconName;
  title: string;
  detail?: VNodeChild;
  accessory?: VNodeChild;
  onClick: () => void;
  disabled?: boolean;
}) {
  return ({ icon, title, detail, accessory, onClick, disabled }) => {
    return (
      <button type="button" class="settings-row settings-nav-row" onClick={onClick} disabled={disabled}>
        <span class="surface-icon">
          <Icon name={icon} size={21} />
        </span>
        <span class="settings-nav-copy">
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
        {accessory && <span class="settings-nav-accessory">{accessory}</span>}
        <Icon name="chevron" size={16} />
      </button>
    );
  };
});
export default tsxComponent(function MePages(_props: {
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  back: () => void;
  software: {
    website: boolean;
    android?: AndroidRelease | null;
    androidAvailable: boolean;
    androidUpdateState?: AndroidUpdateState;
    androidUpdateProgress?: number | null;
  };
  updateBlocked: boolean;
}) {
  const usageState = shallowRef<string>();
  const setUsage = writeRef(usageState);
  const workingState = shallowRef(false);
  const noticeState = shallowRef('');
  const watchUsage = watchRender();
  const pwaInstall = usePwaInstall();
  return ({ route, navigate, back, software, updateBlocked }) => {
    const { user, setUser } = useMessaging();
    const name = user?.displayName ?? '登录或创建账户';
    const usage = usageState.value;
    const working = workingState.value;
    async function run(action: () => Promise<void>) {
      workingState.value = true;
      noticeState.value = '';
      try {
        await action();
      } catch (error) {
        noticeState.value = error instanceof Error ? error.message : '操作未完成，请重试';
      } finally {
        workingState.value = false;
      }
    }
    watchUsage(() => {
      if (route.page !== 'settings') return;
      setUsage(undefined);
      let alive = true;
      void deviceSession.cache
        .usage()
        .then((u) => {
          if (alive) setUsage(formatBytes(u.bytes));
        })
        .catch(() => {
          if (alive) setUsage('暂不可用');
        });
      return () => {
        alive = false;
      };
    }, [route.page]);
    const titles: Partial<Record<AppRoute['page'], string>> = {
      me: '我的',
      settings: '设置',
      plugins: '插件管理',
      appearance: '外观',
      devices: '我的电脑',
      integrations: 'Agent 接入',
      profile: '个人资料',
      'login-security': '登录与安全',
      'trusted-devices': '通行密钥',
      'login-devices': '登录设备',
      authenticators: '第三方验证器',
      'account-recovery': '账户恢复',
      'account-credentials': '密码与恢复码',
      resources: '账号资源',
      about: '关于',
      donation: '支持项目',
      downloads: '软件下载',
    };
    return (
      <main
        class={`module-page me-page${['me', 'settings', 'plugins', 'resources', 'account-credentials', 'login-security', 'trusted-devices', 'login-devices', 'authenticators', 'account-recovery'].includes(route.page) ? ' settings-hierarchy' : ''}`}
      >
        <PageHeader title={titles[route.page] ?? '我的'} back={route.page === 'me' ? undefined : back} />
        {route.page === 'me' && (
          <div class="settings-hierarchy-content settings-primary-menu">
            <button class="profile-card settings-profile-card" onClick={() => navigate({ page: 'profile' })}>
              <Avatar user={user ?? { displayName: '我', kind: 'human' }} large />
              <span class="settings-profile-copy">
                <strong>{name}</strong>
                <small>{user ? `UID ${user.id}` : '与你的 Agent 聊天'}</small>
              </span>
              <span class="settings-profile-link">
                <span>{user ? '个人资料' : '登录'}</span>
                <Icon name="chevron" size={16} />
              </span>
            </button>
            <section class="settings-section" aria-labelledby="me-account-group">
              <h2 class="settings-section-title" id="me-account-group">
                账号
              </h2>
              <Row
                icon="shield"
                title="登录与安全"
                detail="动态码、扫码与恢复方式"
                onClick={() => navigate({ page: 'login-security' })}
              />
            </section>
            <section class="settings-section" aria-labelledby="me-workspace-group">
              <h2 class="settings-section-title" id="me-workspace-group">
                工作空间
              </h2>
              <Row icon="monitor" title="我的电脑" onClick={() => navigate({ page: 'devices' })} />
              <Row
                icon="stack"
                title="Agent 接入"
                onClick={() => navigate({ page: 'integrations', from: 'me' })}
              />
            </section>
            <section class="settings-section" aria-labelledby="me-preferences-group">
              <h2 class="settings-section-title" id="me-preferences-group">
                偏好
              </h2>
              {(pwaInstall.available.value || pwaInstall.feedback.value) && (
                <Row
                  icon="phone"
                  title="安装到主屏幕"
                  detail={pwaInstall.feedback.value || '以独立应用方式打开子虚亭'}
                  disabled={!pwaInstall.available.value || pwaInstall.busy.value}
                  onClick={() => void pwaInstall.install()}
                />
              )}
              <Row
                icon="download"
                title="软件下载"
                detail="Android 应用与电脑适配器"
                accessory={software.website || software.androidAvailable ? '有更新' : undefined}
                onClick={() => navigate({ page: 'downloads' })}
              />
              <Row
                icon="heart"
                title="支持项目"
                detail="赞赏与支持开发"
                onClick={() => navigate({ page: 'donation' })}
              />
              <Row icon="document" title="下载诊断日志" onClick={downloadDiagnostics} />
              <Row
                icon="sliders"
                title="设置"
                detail="外观、插件、缓存与关于"
                onClick={() => navigate({ page: 'settings' })}
              />
            </section>
          </div>
        )}
        {[
          'login-security',
          'trusted-devices',
          'login-devices',
          'authenticators',
          'account-recovery',
        ].includes(route.page) && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在读取登录设置…</div>,
              default: () => (
                <LoginSecurity key={JSON.stringify([user?.id, route])} route={route} navigate={navigate} />
              ),
            }}
          </Suspense>
        )}
        {route.page === 'settings' && (
          <div class="settings-hierarchy-content settings-preferences-content">
            {user && <NotificationSettings />}
            <section class="settings-section" aria-labelledby="settings-plugins-group">
              <h2 class="settings-section-title" id="settings-plugins-group">
                扩展与插件
              </h2>
              <Row
                icon="puzzle"
                title="插件管理"
                detail="管理内置终端与自定义插件实例"
                onClick={() => navigate({ page: 'plugins' })}
              />
            </section>
            <section class="settings-section" aria-labelledby="settings-appearance-group">
              <h2 class="settings-section-title" id="settings-appearance-group">
                外观与阅读
              </h2>
              <Row
                icon="palette"
                title="外观"
                detail="主题、图标与行号"
                onClick={() => navigate({ page: 'appearance' })}
              />
            </section>
            <section class="settings-section" aria-labelledby="settings-local-group">
              <h2 class="settings-section-title" id="settings-local-group">
                本机数据
              </h2>
              <Row
                icon="trash"
                title={working ? '正在清理…' : '清理本机缓存'}
                accessory={
                  usage ?? (
                    <span class="settings-usage-pending">
                      <span aria-hidden="true" />
                      计算中…
                    </span>
                  )
                }
                disabled={working}
                onClick={() =>
                  void run(async () => {
                    await deviceSession.cache.clear();
                    setUsage(formatBytes((await deviceSession.cache.usage()).bytes));
                    noticeState.value = '本机缓存已清理';
                  })
                }
              />
              {noticeState.value && (
                <p class="settings-inline-notice" role="status">
                  {noticeState.value}
                </p>
              )}
            </section>
            {user && (
              <section class="settings-section" aria-labelledby="settings-resource-group">
                <h2 class="settings-section-title" id="settings-resource-group">
                  账号资源
                </h2>
                <Row
                  icon="folder"
                  title="云端空间与流量"
                  detail="附件用量、导出与清理"
                  onClick={() => navigate({ page: 'resources' })}
                />
              </section>
            )}
            <section class="settings-section" aria-labelledby="settings-help-group">
              <h2 class="settings-section-title" id="settings-help-group">
                帮助与关于
              </h2>
              <Row icon="info" title="关于" onClick={() => navigate({ page: 'about' })} />
            </section>
            {user && (
              <button
                type="button"
                class="settings-logout"
                disabled={working}
                onClick={() =>
                  void run(async () => {
                    await messaging.request('/logout', 'POST', {});
                    setUser(null);
                    navigate({ page: 'messages' });
                  })
                }
              >
                退出登录
              </button>
            )}
          </div>
        )}
        {route.page === 'account-credentials' &&
          (user ? (
            <Suspense timeout={0}>
              {{
                fallback: () => <div class="page-loading">正在读取账号设置…</div>,
                default: () => <AccountCredentials key={user.id} navigate={navigate} />,
              }}
            </Suspense>
          ) : (
            <div class="pavilion-flow">
              <AccountForm description="登录后管理账号密码与恢复方式。" />
            </div>
          ))}
        {route.page === 'resources' &&
          (user ? (
            <div class="settings-hierarchy-content settings-resource-content">
              <Suspense timeout={0}>
                {{
                  fallback: () => <div class="page-loading">正在读取账号资源…</div>,
                  default: () => <ResourceSettings key={user.id} />,
                }}
              </Suspense>
            </div>
          ) : (
            <div class="pavilion-flow">
              <AccountForm description="登录后查看云端空间与流量。" />
            </div>
          ))}
        {route.page === 'downloads' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在读取安装包…</div>,
              default: () => (
                <>
                  <DownloadsPage
                    websiteUpdate={software.website}
                    androidRelease={software.android}
                    androidUpdate={software.androidAvailable}
                    androidUpdateState={software.androidUpdateState}
                    androidUpdateProgress={software.androidUpdateProgress}
                    updateBlocked={updateBlocked}
                  />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'donation' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在打开支持项目页面…</div>,
              default: () => (
                <>
                  <DonationPage />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'plugins' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在打开插件管理…</div>,
              default: () => (
                <>
                  <PluginSettings navigate={navigate} />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'appearance' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在打开外观设置…</div>,
              default: () => (
                <>
                  <AppearanceSettings />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'about' && (
          <section class="about-content" aria-labelledby="about-app-name">
            <div class="about-brand">
              <BrandIcon class="about-app-icon" size={56} />
              <div>
                <h2 id="about-app-name">子虚亭</h2>
                <p>Fable Pavilion</p>
              </div>
            </div>
            <p>即时聊天与 Agent 工作台。连接电脑后，可继续会话、发送任务和处理审批。</p>
            <small>
              网页版本{' '}
              {typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__.slice(0, 8) : '开发版'}
            </small>
          </section>
        )}
      </main>
    );
  };
});
function formatBytes(value: number) {
  return value < 1024 ** 2
    ? `${Math.ceil(value / 1024)} KB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${(value / 1024 ** 3).toFixed(2)} GB`;
}
