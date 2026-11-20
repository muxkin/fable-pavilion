import { beforeAll, expect, it } from 'vitest';
import { canonical, createSecrets, decode64, protectAccount, seal } from '../src/shared/account-crypto.js';
import {
  createTrustedLoginKey,
  openTrustedLoginRoot,
  sealTrustedLoginRoot,
  trustedLoginKeyFingerprint,
  trustedLoginPossessionProof,
  type TrustedLoginBinding,
} from '../src/shared/trusted-device-crypto.js';

const password = 'test-account-passphrase';
let account: Awaited<ReturnType<typeof protectAccount>>;
let other: Awaited<ReturnType<typeof protectAccount>>;
beforeAll(async () => {
  [account, other] = await Promise.all([protectAccount(password), protectAccount(password)]);
});
function binding(recipientPublicKey: JsonWebKey): TrustedLoginBinding {
  return {
    origin: 'https://pavilion.example',
    requestId: 'request-01234567890123456789',
    accountId: '10001',
    recipientPublicKey,
  };
}

it('hands the existing root only to the intended device without exporting its private key', async () => {
  const key = await createTrustedLoginKey();
  expect(key.privateKey.extractable).toBe(false);
  expect(Object.keys(key.publicKey).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  await expect(crypto.subtle.exportKey('jwk', key.privateKey)).rejects.toThrow();
  const challenge = binding(key.publicKey);
  const envelope = await sealTrustedLoginRoot(account.secrets, challenge);
  expect(JSON.stringify(envelope)).not.toContain(account.secrets.root);
  expect(envelope.iv).toHaveLength(16);
  expect(envelope.data).toHaveLength(64);
  await expect(
    openTrustedLoginRoot(
      account.vault,
      key,
      { ...challenge, origin: 'https://pavilion.example:443' },
      envelope,
    ),
  ).resolves.toEqual(account.secrets);
});

it('rejects a different origin, request, account, recipient, ciphertext, or unrelated vault', async () => {
  const [key, wrongKey] = await Promise.all([createTrustedLoginKey(), createTrustedLoginKey()]);
  const challenge = binding(key.publicKey);
  const envelope = await sealTrustedLoginRoot(account.secrets, challenge);
  for (const modified of [
    { ...challenge, origin: 'https://other.example' },
    { ...challenge, requestId: 'request-11234567890123456789' },
    { ...challenge, accountId: '10002' },
    binding(wrongKey.publicKey),
  ]) {
    await expect(openTrustedLoginRoot(account.vault, key, modified, envelope)).rejects.toThrow();
  }
  await expect(openTrustedLoginRoot(account.vault, wrongKey, challenge, envelope)).rejects.toThrow();
  await expect(openTrustedLoginRoot(other.vault, key, challenge, envelope)).rejects.toThrow();
  await expect(
    openTrustedLoginRoot(account.vault, key, challenge, {
      ...envelope,
      data: (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1),
    }),
  ).rejects.toThrow();
  await expect(
    sealTrustedLoginRoot(account.secrets, { ...challenge, origin: 'http://insecure.example' }),
  ).rejects.toThrow();
});

it('fingerprints the waiting public key and ignores serialization metadata', async () => {
  const first = await createTrustedLoginKey();
  const second = await createTrustedLoginKey();
  const fingerprint = await trustedLoginKeyFingerprint(first.publicKey);
  expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(trustedLoginKeyFingerprint({ ...first.publicKey, ext: true })).resolves.toBe(fingerprint);
  await expect(trustedLoginKeyFingerprint(second.publicKey)).resolves.not.toBe(fingerprint);
  await expect(trustedLoginKeyFingerprint({ ...first.publicKey, d: '' })).rejects.toThrow();
});

it('binds an ECDH possession proof to the waiting key and login request', async () => {
  const [waiting, responder, unrelated] = await Promise.all([
    createTrustedLoginKey(),
    createTrustedLoginKey(),
    createTrustedLoginKey(),
  ]);
  const requestId = binding(waiting.publicKey).requestId;
  const proof = await trustedLoginPossessionProof(waiting.privateKey, responder.publicKey, requestId);
  expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(trustedLoginPossessionProof(responder.privateKey, waiting.publicKey, requestId)).resolves.toBe(
    proof,
  );
  await expect(
    trustedLoginPossessionProof(responder.privateKey, waiting.publicKey, requestId + '-other'),
  ).resolves.not.toBe(proof);
  await expect(
    trustedLoginPossessionProof(unrelated.privateKey, responder.publicKey, requestId),
  ).resolves.not.toBe(proof);
});

it('checks the vault public signing and encryption keys against the delivered account keys', async () => {
  const key = await createTrustedLoginKey();
  const challenge = binding(key.publicKey);
  const envelope = await sealTrustedLoginRoot(account.secrets, challenge);
  await expect(
    openTrustedLoginRoot(account.vault, key, challenge, {
      ...envelope,
      publicKey: { ...envelope.publicKey, x: '' },
    }),
  ).rejects.toThrow();
  await expect(
    openTrustedLoginRoot({ ...account.vault, publicKeys: other.vault.publicKeys }, key, challenge, envelope),
  ).rejects.toThrow();
  const replacementKeys = await createSecrets();
  for (const secrets of [
    { ...account.secrets, signing: replacementKeys.signing },
    { ...account.secrets, encryption: replacementKeys.encryption },
  ]) {
    const vault = {
      ...account.vault,
      secrets: await seal(
        decode64(account.secrets.root),
        new TextEncoder().encode(canonical(secrets)),
        'account-secrets:v1',
      ),
    };
    await expect(openTrustedLoginRoot(vault, key, challenge, envelope)).rejects.toThrow();
  }
});
