import { Icon } from '../Icon';
import { tsxComponent } from '../tsx-component';
import type { AppRoute } from '../shell/routes';
import { useMessaging } from './context';
import { AccountForm } from './AccountPages';
import { TrustedDevices } from './TrustedDevices';
import { LoginDevices } from './LoginDevices';
import { AuthenticatorManagement } from './AuthenticatorManagement';
import './login-security.css';

export default tsxComponent(function LoginSecurity(_props: {
  route: AppRoute;
  navigate: (route: AppRoute) => void;
}) {
  return ({ route, navigate }) => {
    const { user } = useMessaging();
    if (!user)
      return (
        <div class="pavilion-flow">
          <AccountForm description="登录后即可查看动态码，或让另一台设备登录。" />
        </div>
      );
    const recovery = route.page === 'account-recovery';
    const devices = route.page === 'trusted-devices';
    if (route.page === 'login-devices')
      return (
        <div class="login-security-content">
          <LoginDevices key={user.id} navigate={navigate} />
        </div>
      );
    if (route.page === 'authenticators')
      return (
        <div class="login-security-content">
          <AuthenticatorManagement key={user.id} accountId={user.id} />
        </div>
      );
    const action = new URL(location.href).searchParams.get('security-action');
    return (
      <div class="login-security-content">
        {recovery ? (
          <section class="security-recovery-content">
            <h3>没有已登录的设备？</h3>
            <p>在登录页选择「恢复账号」，输入注册时保存的恢复码，恢复后请妥善保存新恢复码。</p>
            <h3>需要重新保存恢复码？</h3>
            <p>可在安全设置中随时更换恢复码。更换后请保存新码。</p>
            <button class="security-action-row" onClick={() => navigate({ page: 'account-credentials' })}>
              <Icon name="key" size={23} />
              <span>
                <strong>管理恢复码</strong>
                <small></small>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          </section>
        ) : (
          <TrustedDevices
            key={`${user.id}:${route.page}:${action ?? ''}`}
            accountId={user.id}
            view={devices ? 'devices' : 'overview'}
            action={action === 'code' || action === 'scan' || action === 'invite' ? action : undefined}
            navigate={navigate}
          />
        )}
      </div>
    );
  };
});
