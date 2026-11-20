import { z } from 'zod';
import { hostIdSchema } from './relay-protocol.js';

export const keybookSyncLifetime = 120_000;
export const keybookSyncChallengeSchema = z
  .object({
    hostId: hostIdSchema,
    deviceId: z.string().uuid(),
    accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    revision: z.number().int().min(1).max(1_000_000),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issuedAt: z.number().int().positive(),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type KeybookSyncChallenge = z.infer<typeof keybookSyncChallengeSchema>;
export const keybookSyncProof = (origin: string, value: Omit<KeybookSyncChallenge, 'signature'>) =>
  new TextEncoder().encode(
    `codex-pocket/keybook-sync/1\n${origin}\n${value.hostId}\n${value.deviceId}\n${value.accountId}\n${value.revision}\n${value.nonce}\n${value.issuedAt}`,
  );
export const keybookRecoveryItem = 'keybook:recovery';
export const keybookRecoverySchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    revision: z.number().int().positive(),
    recoveryCode: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  })
  .strict();
