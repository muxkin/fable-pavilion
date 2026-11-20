import type { QrLoginHandle } from '../client/account';
import { trustedLoginKeyFingerprint } from '../shared/trusted-device-crypto';

export type QrInvitationCredentials = { id: string; secret: string };

export async function qrLoginUrl(handle: QrLoginHandle) {
  const url = new URL('/', location.origin);
  url.searchParams.set('page', 'login-security');
  url.searchParams.set('login-qr', handle.id);
  url.searchParams.set('login-key', await trustedLoginKeyFingerprint(handle.key.publicKey));
  return url.href;
}

const configuredLoginOrigins = new Set(
  typeof __POCKET_LOGIN_REDIRECT_ORIGINS__ !== 'undefined' && Array.isArray(__POCKET_LOGIN_REDIRECT_ORIGINS__)
    ? __POCKET_LOGIN_REDIRECT_ORIGINS__
    : [],
);

export class InvitationAtAnotherSite extends Error {
  constructor(readonly url: URL) {
    super('请在二维码所属站点继续登录');
  }
}

type AndroidLoginSite = Window & { fablePavilionUseLoginSite?: (url: string) => boolean };

function androidLoginSite() {
  return (window as AndroidLoginSite).fablePavilionUseLoginSite;
}

export function switchAndroidLoginSite(url: URL) {
  return url.protocol === 'https:' && androidLoginSite()?.(url.href) === true;
}

export function parseQrInvitationUrl(text: string): QrInvitationCredentials {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error('请扫描子虚亭的登录邀请二维码');
  }
  if (url.username || url.password) throw new Error('该二维码无法用于当前站点登录');
  const params = new URLSearchParams(url.hash.slice(1));
  const invite = params.get('invite');
  const match = invite?.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/,
  );
  if (
    url.pathname !== '/' ||
    Array.from(url.searchParams.keys()).length !== 1 ||
    url.searchParams.get('page') !== 'login-invite' ||
    Array.from(params.keys()).length !== 1 ||
    !match
  )
    throw new Error('邀请链接无效，请重新扫描登录邀请二维码');
  if (url.origin !== location.origin) {
    if (url.protocol === 'https:' && (configuredLoginOrigins.has(url.origin) || androidLoginSite()))
      throw new InvitationAtAnotherSite(url);
    throw new Error('请在出示二维码的站点登录');
  }
  return { id: match[1]!, secret: match[2]! };
}
