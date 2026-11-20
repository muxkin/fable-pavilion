import { apiCall } from '../src/shared/rpc.js';
import { expect, it } from 'vitest';
import { DEFAULT_BACKEND } from '../src/shared/backends';
import { backDestination, mobileParents, readRoute, routeURL, parentRoute } from '../src/web/shell/routes';
it('restores a host-scoped conversation and keeps browser back destinations explicit', () => {
  const route = { page: 'workbench' as const, thread: 'chat-123', host: 'host123' };
  expect(readRoute(new URL(routeURL(route), 'https://app.invalid'))).toEqual(route);
  expect(parentRoute(route)).toEqual({ page: 'workbench', backend: DEFAULT_BACKEND, host: route.host });
  expect(readRoute(new URL('https://app.invalid/?page=settings&thread=chat-123'))).toEqual({
    page: 'settings',
  });
});

it('fills only the missing mobile workbench parents and keeps a fork linked to its source', () => {
  const home = { page: 'workbench' } as const;
  const list = { ...home, backend: DEFAULT_BACKEND, host: 'computer' };
  const source = { ...list, thread: 'source' };
  const fork = { ...list, thread: 'fork' };
  expect(mobileParents(source, home)).toEqual([list]);
  expect(mobileParents(source)).toEqual([home, list]);
  expect(mobileParents(source, list)).toEqual([]);
  expect(mobileParents(fork, source)).toEqual([]);
  expect(backDestination(fork, source)).toBe(source);
  expect(backDestination(fork, { ...source, host: 'other' })).toEqual(list);
});

it('reconstructs settings parents for deep links and preserves the setup entry it was opened from', () => {
  expect(mobileParents({ page: 'appearance' })).toEqual([{ page: 'me' }, { page: 'settings' }]);
  expect(mobileParents({ page: 'downloads' }, { page: 'pair' })).toEqual([]);
  expect(mobileParents({ page: 'desktop-authorization' })).toEqual([]);
});

it('keeps contact details in the contact module with a portable list return', () => {
  const list = { page: 'contacts' } as const;
  const route = { ...list, contact: 'agent-123' };
  expect(readRoute(new URL(routeURL(route), 'https://example.com'))).toEqual(route);
  expect(parentRoute(route)).toEqual(list);
  expect(mobileParents(route, list)).toEqual([]);
  expect(readRoute(new URL('https://example.com/?page=contacts&contact=%2Finvalid'))).toEqual(list);
});
it('handles one-use pairing fragments before ordinary routes without reflecting secrets', () => {
  expect(readRoute(new URL('https://app.invalid/?page=me#pair=secret&host=computer'))).toEqual({
    page: 'pair',
  });
  expect(routeURL({ page: 'pair' })).toBe('/?page=pair');
  expect(readRoute(new URL('https://app.invalid/?page=unknown'))).toEqual({ page: 'messages' });
});

it('round-trips opaque native IDs and preserves the selected backend', () => {
  const thread = 'native:id?# with spaces';
  const route = { page: 'workbench' as const, backend: 'dsh-one', thread };
  expect(readRoute(new URL(routeURL(route), 'https://example.com'))).toEqual(route);
  expect(apiCall(`/threads/${encodeURIComponent(thread)}/history`).params.id).toBe(thread);
});

it('keeps messaging conversation identities separate from desktop thread routes', () => {
  const conversation = '12345678-1234-1234-1234-123456789abc';
  const route = { page: 'messages' as const, conversation };
  expect(readRoute(new URL(routeURL(route), 'https://app.invalid'))).toEqual(route);
  expect(parentRoute(route)).toEqual({ page: 'messages' });
  expect(readRoute(new URL('https://app.invalid/?page=contacts&conversation=' + conversation))).toEqual({
    page: 'contacts',
  });
  expect(
    readRoute(new URL('https://app.invalid/?page=messages&conversation=invalid&thread=private')),
  ).toEqual({ page: 'messages' });
  expect(parentRoute({ page: 'integrations' })).toEqual({ page: 'contacts' });
});

it('opens messages from the root and preserves explicit workspace links', () => {
  expect(readRoute(new URL('https://app.invalid/'))).toEqual({ page: 'messages' });
  expect(readRoute(new URL('https://app.invalid/?page=workbench&backend=dsh'))).toEqual({
    page: 'workbench',
    backend: 'dsh',
  });
});

it('keeps settings detail pages under their actual account or preferences parent', () => {
  expect(parentRoute({ page: 'account-credentials' })).toEqual({ page: 'login-security' });
  expect(parentRoute({ page: 'account-recovery' })).toEqual({ page: 'account-credentials' });
  expect(parentRoute({ page: 'downloads' })).toEqual({ page: 'me' });
  for (const page of ['login-devices', 'authenticators'] as const)
    expect(parentRoute({ page })).toEqual({ page: 'login-security' });
  for (const page of ['resources', 'donation'] as const)
    expect(parentRoute({ page })).toEqual({ page: 'settings' });
});

it('preserves the Agent entry context without accepting unrelated return destinations', () => {
  const route = { page: 'integrations' as const, from: 'me' as const };
  expect(readRoute(new URL(routeURL(route), 'https://example.com'))).toEqual(route);
  expect(parentRoute(route)).toEqual({ page: 'me' });
  expect(readRoute(new URL('https://example.com/?page=integrations&from=https://untrusted.invalid'))).toEqual(
    { page: 'integrations' },
  );
  expect(readRoute(new URL('https://example.com/?page=settings&from=me'))).toEqual({ page: 'settings' });
});
