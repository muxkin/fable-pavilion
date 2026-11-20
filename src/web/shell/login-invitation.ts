import { parseQrInvitationUrl } from '../trusted-login';
import type { AppRoute } from './routes';

export function takeLoginInvitation(route: AppRoute) {
  if (route.page !== 'login-invite' || !location.hash) return;
  const link = location.href;
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    return parseQrInvitationUrl(link);
  } catch {
    return;
  }
}
