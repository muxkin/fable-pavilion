import { assetSettings } from '../shared/assets.js';
import { edgeSecurityHeaders } from '../server/edge-policy.js';
import type { Env } from './env.js';

function exactOrigin(value: string, key: string) {
  const url = new URL(value);
  if (url.origin !== value || !['http:', 'https:'].includes(url.protocol))
    throw Error(`${key} must contain exact HTTP(S) origins`);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw Error('Public deployments require HTTPS');
  return url.origin;
}
export function originFor(env: Env) {
  return exactOrigin(env.POCKET_PUBLIC_ORIGIN, 'POCKET_PUBLIC_ORIGIN');
}
export function originsFor(env: Env) {
  return new Set([
    originFor(env),
    ...(env.POCKET_ORIGIN_ALIASES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => exactOrigin(value, 'POCKET_ORIGIN_ALIASES')),
  ]);
}
export function identityAuthorityFor(env: Env) {
  const origin = env.POCKET_IM_IDENTITY_ORIGIN
    ? exactOrigin(env.POCKET_IM_IDENTITY_ORIGIN, 'POCKET_IM_IDENTITY_ORIGIN')
    : originFor(env);
  return new URL(origin).host.toLowerCase();
}
export function securityHeaders(env: Env) {
  return edgeSecurityHeaders(
    assetSettings(env.POCKET_ASSET_BASE).origin,
    (env.POCKET_UPLOAD_ORIGINS ?? '').split(',').filter(Boolean),
  );
}
