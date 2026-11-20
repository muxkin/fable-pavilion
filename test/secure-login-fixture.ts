import { vi } from 'vitest';
import { AccountClient, TrustedLoginRequired } from '../src/client/account.js';

export const TEST_TOTP_KEY = Buffer.alloc(32, 91).toString('base64url');

/** Existing business suites complete real OTP challenges using another signed-in test device. */
export function signedInDeviceFixture() {
  const devices: AccountClient[] = [];
  const now = Date.now.bind(Date);
  let offset = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
  return {
    dispose: () => clock.mockRestore(),
    wrap<T extends AccountClient>(account: T): T {
      devices.push(account);
      const login = account.login.bind(account);
      account.login = async (identifier, password, recovery, context) => {
        try {
          return await login(identifier, password, recovery, context);
        } catch (error) {
          if (!(error instanceof TrustedLoginRequired)) throw error;
          // Each successful login consumes a TOTP step. Advance only the synthetic test clock.
          offset += 31_000;
          const local = identifier.toLowerCase().replace(/^@/, '').split('@')[0];
          for (const device of devices) {
            if (!device.user || ![device.user.id, device.user.username.toLowerCase()].includes(local))
              continue;
            let code: string;
            try {
              ({ code } = await device.request<{ code: string }>('/crypto/totp/display', 'POST', {}));
            } catch {
              continue; // Password changes revoke the earlier device's session.
            }
            return account.completeTrustedLogin(error.request, code, password);
          }
          throw error;
        }
      };
      return account;
    },
  };
}
