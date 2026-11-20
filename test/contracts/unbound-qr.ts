import { expect, it } from 'vitest';
import type { AccountClient, QrLoginHandle, TrustedLoginRequest } from '../../src/client/account.js';
import {
  createTrustedLoginKey,
  sealTrustedLoginRoot,
  signDeviceLoginApproval,
  trustedLoginPossessionProof,
  type TrustedDevicePublicKey,
} from '../../src/shared/trusted-device-crypto.js';

type Client = {
  account: AccountClient;
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  cookie(): string;
};

export function unboundQrContract(setup: () => Promise<{ origin: string; session(): Client }>) {
  it('binds an account-free QR only to the first signed approval and redeems it once', async () => {
    const { origin, session } = await setup();
    const scanners = [session(), session()];
    for (const [index, scanner] of scanners.entries())
      await scanner.account.register(`unbound-qr-${index}`, `QR Scanner ${index}`, 'synthetic-qr-password');
    const recipient = session();
    const key = await createTrustedLoginKey();
    const body = { name: 'New browser', publicKey: key.publicKey };
    await expect(scanners[0]!.request('/crypto/qr/start', 'POST', body)).rejects.toMatchObject({
      status: 409,
    });

    // A legacy lookup for a nonexistent user is intentionally incapable of being approved.
    const unknown = await recipient.request<TrustedLoginRequest>('/crypto/qr/start', 'POST', {
      ...body,
      identifier: 'no-matching-account',
    });
    await expect(scanners[0]!.request(`/crypto/qr/${unknown.id}`)).rejects.toMatchObject({ status: 404 });

    const { proofKey, ...challenge } = await recipient.request<
      TrustedLoginRequest & { proofKey: TrustedDevicePublicKey }
    >('/crypto/qr/start', 'POST', body);
    expect(challenge.deviceBound).toBe(true);
    const proof = await trustedLoginPossessionProof(key.privateKey, proofKey, challenge.id);
    const handle: QrLoginHandle = { ...challenge, key, proof };
    const redeem = { id: handle.id, claim: handle.claim, proof };
    expect(recipient.cookie()).toBe('');
    await expect(recipient.request(`/crypto/qr/${handle.id}`)).rejects.toMatchObject({ status: 401 });
    await expect(
      recipient.request('/crypto/qr/redeem', 'POST', { ...redeem, proof: 'f'.repeat(43) }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await recipient.account.checkQrLogin(handle, origin)).toEqual({ pending: true });
    expect(await recipient.request('/me')).toEqual({ user: null });

    const approvals = await Promise.all(
      scanners.map(async (scanner) => {
        const request = await scanner.request<TrustedLoginRequest & { publicKey: TrustedDevicePublicKey }>(
          `/crypto/qr/${handle.id}`,
        );
        expect(request.deviceBound).toBe(true);
        expect(request.publicKey).toEqual(key.publicKey);
        const scope = {
          origin,
          requestId: request.id,
          accountId: scanner.account.user!.id,
          recipientPublicKey: request.publicKey,
        };
        const envelope = await sealTrustedLoginRoot(scanner.account.secrets!, scope);
        const signature = await signDeviceLoginApproval(scanner.account.secrets!.signing, {
          ...scope,
          revision: scanner.account.revision,
          expiresAt: request.expiresAt,
          envelope,
        });
        return { id: request.id, envelope, signature };
      }),
    );
    await expect(
      scanners[0]!.request('/crypto/qr/approve', 'POST', {
        id: handle.id,
        envelope: approvals[0]!.envelope,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      scanners[0]!.request('/crypto/qr/approve', 'POST', {
        ...approvals[0],
        signature: approvals[1]!.signature,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await recipient.account.checkQrLogin(handle, origin)).toEqual({ pending: true });

    const results = await Promise.allSettled(
      scanners.map((scanner, index) => scanner.request('/crypto/qr/approve', 'POST', approvals[index])),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: { ok: true } },
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 404 }) }),
    ]);
    const winner = scanners[results.findIndex((result) => result.status === 'fulfilled')]!;
    expect(recipient.cookie()).toBe('');
    await expect(scanners[0]!.request('/crypto/qr/redeem', 'POST', redeem)).rejects.toMatchObject({
      status: 409,
    });
    await recipient.account.checkQrLogin(handle, origin);
    expect(recipient.account.user!.id).toBe(winner.account.user!.id);
    expect(recipient.account.secrets!.root).toBe(winner.account.secrets!.root);
    expect(recipient.cookie()).not.toBe('');
    await expect(recipient.request('/crypto/qr/redeem', 'POST', redeem)).rejects.toMatchObject({
      status: 404,
    });
  });
}
