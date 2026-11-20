import { AccountClient } from '../../client/account';
import { HttpMessagingClient } from '../../client/messaging';

export const deviceLoginRequired =
  typeof __POCKET_DEVICE_LOGIN_ONLY__ === 'boolean' && __POCKET_DEVICE_LOGIN_ONLY__;
export const accountHttp = new HttpMessagingClient();

// Keep the keys opened by the lightweight login in the same AccountClient that Vue uses.
export const account = new AccountClient(
  (path, method, body, signal) => accountHttp.request(path, method, body, signal),
  deviceLoginRequired,
);
