import { DEFAULT_BACKEND } from '../../shared/backends';
import { afterDialogs } from './dialog-history';

export type AppPage =
  | 'messages'
  | 'contacts'
  | 'workbench'
  | 'me'
  | 'settings'
  | 'appearance'
  | 'devices'
  | 'integrations'
  | 'profile'
  | 'login-security'
  | 'trusted-devices'
  | 'login-devices'
  | 'authenticators'
  | 'account-recovery'
  | 'account-credentials'
  | 'resources'
  | 'admin'
  | 'donation'
  | 'downloads'
  | 'about'
  | 'add-computer'
  | 'account-login'
  | 'pair'
  | 'login-invite'
  | 'desktop-authorization';
export interface AppRoute {
  page: AppPage;
  from?: 'me' | 'contacts' | 'messages';
  securityAction?: 'code' | 'scan' | 'invite';
  backend?: string;
  thread?: string;
  host?: string;
  conversation?: string;
  contact?: string;
}
const pages: AppPage[] = [
  'messages',
  'contacts',
  'workbench',
  'me',
  'settings',
  'appearance',
  'devices',
  'integrations',
  'profile',
  'login-security',
  'trusted-devices',
  'login-devices',
  'authenticators',
  'account-recovery',
  'account-credentials',
  'resources',
  'admin',
  'donation',
  'downloads',
  'about',
  'add-computer',
  'account-login',
  'pair',
  'login-invite',
  'desktop-authorization',
];
export function readRoute(url: URL): AppRoute {
  const page = url.searchParams.get('page') as AppPage;
  if (page !== 'login-invite' && new URLSearchParams(url.hash.slice(1)).has('pair')) return { page: 'pair' };
  const thread = url.searchParams.get('thread');
  const host = url.searchParams.get('host');
  const conversation = url.searchParams.get('conversation');
  const contact = url.searchParams.get('contact');
  const securityAction = url.searchParams.get('security-action');
  const from = url.searchParams.get('from');
  return {
    ...(page === 'integrations' && (from === 'me' || from === 'contacts' || from === 'messages')
      ? { from }
      : {}),
    ...(url.searchParams.get('backend') && /^[a-zA-Z0-9_-]{1,80}$/.test(url.searchParams.get('backend')!)
      ? { backend: url.searchParams.get('backend')! }
      : {}),
    page:
      page === 'profile' && url.searchParams.has('login-qr')
        ? 'login-security'
        : pages.includes(page)
          ? page
          : 'messages',
    ...(page === 'messages' && conversation && /^[a-f0-9-]{36}$/.test(conversation) ? { conversation } : {}),
    ...(page === 'contacts' && contact && /^[a-zA-Z0-9_-]{1,100}$/.test(contact) ? { contact } : {}),
    ...(page === 'login-security' &&
    (securityAction === 'code' || securityAction === 'scan' || securityAction === 'invite')
      ? { securityAction }
      : {}),
    ...(page === 'workbench' && thread && /^[^\x00-\x1f/\\]{1,200}$/.test(thread) ? { thread } : {}),
    ...(page === 'workbench' && host && /^[a-zA-Z0-9]{1,200}$/.test(host) ? { host } : {}),
  };
}
export function routeURL(route: AppRoute): string {
  const query = new URLSearchParams({ page: route.page });
  if (route.page === 'integrations' && route.from) query.set('from', route.from);
  if (route.page === 'login-security' && route.securityAction)
    query.set('security-action', route.securityAction);
  if (route.backend) query.set('backend', route.backend);
  if (route.page === 'messages' && route.conversation) query.set('conversation', route.conversation);
  if (route.page === 'contacts' && route.contact) query.set('contact', route.contact);
  if (route.page === 'workbench' && route.thread) {
    query.set('thread', route.thread);
  }
  if (route.page === 'workbench' && route.host) query.set('host', route.host);
  return `/?${query}`;
}

/** Return to the parent without pushing the detail page back onto the history stack. */
export function backTo(route: AppRoute, navigate: (route: AppRoute, replace?: boolean) => void) {
  afterDialogs(() => {
    if (history.state?.pocket && history.state.previousRoute === routeURL(route)) history.back();
    else navigate(route, true);
  });
}

export function parentRoute(route: AppRoute): AppRoute {
  if (route.page === 'messages') return { page: 'messages' };
  if (route.page === 'contacts') return { page: 'contacts' };
  if (route.page === 'integrations') return { page: route.from ?? 'contacts' };
  if (route.page === 'workbench')
    return route.thread
      ? { page: 'workbench', backend: route.backend ?? DEFAULT_BACKEND, host: route.host }
      : { page: 'workbench' };
  if (route.page === 'pair') return { page: 'devices' };
  if (route.page === 'add-computer' || route.page === 'account-login') return { page: 'workbench' };
  if (['about', 'appearance', 'resources'].includes(route.page)) return { page: 'settings' };
  if (route.page === 'account-recovery') return { page: 'account-credentials' };
  if (['trusted-devices', 'login-devices', 'authenticators', 'account-credentials'].includes(route.page))
    return { page: 'login-security' };
  return { page: 'me' };
}

const setupParents: Partial<Record<AppPage, AppPage[]>> = {
  'add-computer': ['workbench', 'devices'],
  'account-login': ['workbench', 'devices'],
  downloads: ['workbench', 'devices', 'add-computer', 'pair'],
  pair: ['workbench', 'devices', 'add-computer', 'account-login'],
  'login-security': ['messages', 'contacts', 'workbench'],
};

export function previousHistoryRoute(): AppRoute | undefined {
  const route = history.state?.pocket && history.state.previousRoute;
  if (typeof route === 'string' && route.startsWith('/?')) return readRoute(new URL(route, location.origin));
}

export function backDestination(route: AppRoute, previous?: AppRoute): AppRoute {
  if (previous && setupParents[route.page]?.includes(previous.page)) return previous;
  if (
    previous?.page === 'workbench' &&
    route.page === 'workbench' &&
    previous.thread &&
    previous.thread !== 'new' &&
    route.thread &&
    previous.thread !== route.thread &&
    routeURL(parentRoute(previous)) === routeURL(parentRoute(route))
  )
    return previous;
  return parentRoute(route);
}

/** Fill missing parent screens before a mobile detail, including an initial deep link. */
export function mobileParents(route: AppRoute, previous?: AppRoute): AppRoute[] {
  const parents: AppRoute[] = [];
  let child = route;
  while (child.page !== 'login-invite' && child.page !== 'desktop-authorization') {
    const parent = backDestination(child, previous);
    const url = routeURL(parent);
    if (url === routeURL(child) || (previous && url === routeURL(previous))) break;
    parents.unshift(parent);
    child = parent;
  }
  return parents;
}
