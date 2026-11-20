import {
  canonical,
  decode64,
  decryptFor,
  derive,
  encode64,
  encryptFor,
  seal,
  unlockAccountRoot,
  unseal,
  type AccountSecrets,
  type AccountVault,
  type Ciphertext,
} from './account-crypto.js';
import { USER_ID_PATTERN } from './account-identity.js';

export interface TrustedDevicePublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}
export interface TrustedLoginKey {
  privateKey: CryptoKey;
  publicKey: TrustedDevicePublicKey;
}
export interface TrustedLoginBinding {
  origin: string;
  requestId: string;
  accountId: string;
  recipientPublicKey: JsonWebKey;
}
export interface TrustedLoginEnvelope extends Ciphertext {
  publicKey: TrustedDevicePublicKey;
}

const curve = { name: 'ECDH', namedCurve: 'P-256' };
const coordinate = /^[A-Za-z0-9_-]{43}$/;
const request = /^[A-Za-z0-9_-]{22,128}$/;
const nonce = /^[A-Za-z0-9+/]{16}$/;
const ciphertext = /^[A-Za-z0-9+/]{64}$/;

function base64url(bytes: Uint8Array) {
  return encode64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function publicPoint(key: JsonWebKey): TrustedDevicePublicKey {
  if (
    key?.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    key.d !== undefined ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string' ||
    !coordinate.test(key.x) ||
    !coordinate.test(key.y)
  )
    throw Error('设备公钥格式无效');
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
}

function context(binding: TrustedLoginBinding, senderPublicKey: TrustedDevicePublicKey) {
  const url = new URL(binding.origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    typeof binding.requestId !== 'string' ||
    !request.test(binding.requestId) ||
    typeof binding.accountId !== 'string' ||
    !USER_ID_PATTERN.test(binding.accountId)
  )
    throw Error('登录授权范围无效');
  return canonical({
    type: 'trusted-device-root-handoff:v1',
    origin: url.origin,
    requestId: binding.requestId,
    accountId: binding.accountId,
    recipientPublicKey: publicPoint(binding.recipientPublicKey),
    senderPublicKey,
  });
}

async function wrappingKey(privateKey: CryptoKey, peer: TrustedDevicePublicKey, transcript: string) {
  const publicKey = await crypto.subtle.importKey('jwk', peer, curve, false, []);
  const input = new Uint8Array(
    await crypto.subtle.deriveBits({ name: curve.name, public: publicKey }, privateKey, 256),
  );
  try {
    return await derive(input, transcript);
  } finally {
    input.fill(0);
  }
}

export async function createTrustedLoginKey(): Promise<TrustedLoginKey> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(curve, false, ['deriveBits']);
  return { privateKey, publicKey: publicPoint(await crypto.subtle.exportKey('jwk', publicKey)) };
}

/** Carry this fingerprint in the QR so approval can verify the key from the waiting screen. */
export async function trustedLoginKeyFingerprint(publicKey: JsonWebKey): Promise<string> {
  const point = new TextEncoder().encode(`trusted-device-recipient:v1:${canonical(publicPoint(publicKey))}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', point));
  return base64url(digest);
}

/** Prove possession of the waiting device key by binding its shared key to the login request. */
export async function trustedLoginPossessionProof(
  privateKey: CryptoKey,
  responderPublicKey: TrustedDevicePublicKey,
  requestId: string,
): Promise<string> {
  if (typeof requestId !== 'string' || !request.test(requestId)) throw Error('登录授权范围无效');
  const publicKey = await crypto.subtle.importKey('jwk', publicPoint(responderPublicKey), curve, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: curve.name, public: publicKey }, privateKey, 256),
  );
  const material = new TextEncoder().encode(
    `fable-pavilion:qr-possession:v1:${requestId}:${base64url(shared)}`,
  );
  try {
    return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', material)));
  } finally {
    shared.fill(0);
    material.fill(0);
  }
}

/** Encrypt the account root to the key shown by the waiting device. */
export async function sealTrustedLoginRoot(
  secrets: AccountSecrets,
  binding: TrustedLoginBinding,
): Promise<TrustedLoginEnvelope> {
  const recipient = publicPoint(binding.recipientPublicKey);
  const sender = await createTrustedLoginKey();
  const transcript = context(binding, sender.publicKey);
  const key = await wrappingKey(sender.privateKey, recipient, transcript);
  let root: Uint8Array | undefined;
  try {
    root = decode64(secrets.root);
    if (root.length !== 32 || encode64(root) !== secrets.root) throw Error('账号密钥格式无效');
    return { publicKey: sender.publicKey, ...(await seal(key, root, transcript)) };
  } finally {
    key.fill(0);
    root?.fill(0);
  }
}

/** Verify the encrypted handoff against the waiting device and open the existing account vault. */
export async function openTrustedLoginRoot(
  vault: AccountVault,
  recipient: TrustedLoginKey,
  binding: TrustedLoginBinding,
  envelope: TrustedLoginEnvelope,
): Promise<AccountSecrets> {
  if (canonical(publicPoint(binding.recipientPublicKey)) !== canonical(publicPoint(recipient.publicKey)))
    throw Error('登录授权与当前设备不匹配');
  if (
    typeof envelope?.iv !== 'string' ||
    typeof envelope.data !== 'string' ||
    !nonce.test(envelope.iv) ||
    !ciphertext.test(envelope.data)
  )
    throw Error('登录密钥封装格式无效');
  const sender = publicPoint(envelope.publicKey);
  const transcript = context(binding, sender);
  const key = await wrappingKey(recipient.privateKey, sender, transcript);
  let root: Uint8Array | undefined;
  try {
    root = await unseal(key, envelope, transcript);
    const secrets = await unlockAccountRoot(vault, root);
    // A local round-trip proves both private keys match the public keys in the vault.
    const probe = encode64(crypto.getRandomValues(new Uint8Array(32)));
    const id = binding.accountId;
    const scope = 'trusted-device-vault-verification:v1';
    const sealed = await encryptFor(secrets, id, { [id]: vault.publicKeys }, scope, probe);
    if ((await decryptFor(secrets, id, id, vault.publicKeys, scope, sealed)) !== probe)
      throw Error('账号密钥不匹配');
    return secrets;
  } finally {
    key.fill(0);
    root?.fill(0);
  }
}

// The code is derived on both devices from the actual receiving public key.
export async function deviceLoginMatchCode(requestId: string, key: JsonWebKey) {
  const context = new TextEncoder().encode(canonical(['device-login-code:v1', requestId, publicPoint(key)]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', context));
  return Array.from(digest.subarray(0, 5), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

type DeviceLoginApproval = {
  origin: string;
  accountId: string;
  revision: number;
  requestId: string;
  expiresAt: number;
  recipientPublicKey: JsonWebKey;
  envelope: TrustedLoginEnvelope;
};
const approvalBytes = (request: DeviceLoginApproval) =>
  new TextEncoder().encode(
    canonical({
      ...request,
      recipientPublicKey: publicPoint(request.recipientPublicKey),
      purpose: 'device-login-approval:v1',
    }),
  );

export async function signDeviceLoginApproval(privateKey: JsonWebKey, request: DeviceLoginApproval) {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return encode64(
    new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, approvalBytes(request))),
  );
}

export async function verifyDeviceLoginApproval(
  publicKey: JsonWebKey,
  request: DeviceLoginApproval,
  signature: string,
) {
  const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ]);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    decode64(signature),
    approvalBytes(request),
  );
}
