/** RFC 6238 parameters shared by the server and authenticator provisioning UI. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_PERIOD_MS = TOTP_PERIOD_SECONDS * 1000;
export const TOTP_DIGITS = 6;
export const TOTP_CODE_PATTERN = /^\d{6}$/;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function totpCounter(now: number) {
  return Math.floor(now / TOTP_PERIOD_MS);
}

export function totpCounterBytes(counter: number) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw Error('动态码计数器无效');
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  return message;
}

export function totpFromHmac(hmac: Uint8Array) {
  if (hmac.length !== 20) throw Error('动态码摘要格式无效');
  const offset = hmac[hmac.length - 1] & 15;
  const value = new DataView(hmac.buffer, hmac.byteOffset, hmac.byteLength).getUint32(offset) & 0x7fffffff;
  return String(value % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpBase32(bytes: Uint8Array) {
  let rest = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    rest = (rest << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32[(rest >> bits) & 31];
    }
    rest &= (1 << bits) - 1;
  }
  if (bits) output += BASE32[(rest << (5 - bits)) & 31];
  return output;
}

export function totpProvisioningUri(secret: string, accountLabel: string) {
  const issuer = 'Fable Pavilion';
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}?${query}`;
}
