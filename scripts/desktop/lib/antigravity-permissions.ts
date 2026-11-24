import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ControlCatalog } from '../../../src/shared/controls.js';
import type { RpcCall } from '../../../src/shared/rpc.js';
import { ANTIGRAVITY_FIXTURE_CONSTANTS, type AntigravityFixture } from './antigravity-fixture.js';
import { waitFor } from './native-helpers.js';

interface PermissionSmokeOptions {
  rpc: <T>(call: RpcCall) => Promise<T>;
  scoped: (path: string, method?: string, body?: unknown) => RpcCall;
  fixture: AntigravityFixture;
}

export async function verifyAntigravityPermissions({ rpc, scoped, fixture }: PermissionSmokeOptions) {
  const { threadId, switchId, initialTitle } = ANTIGRAVITY_FIXTURE_CONSTANTS;
  const read = (id: string = threadId) => rpc<ControlCatalog>(scoped(`/threads/${id}/controls`));
  const send = async (
    value: string,
    catalog: ControlCatalog,
    state: 'completed' | 'rejected',
    id: string = threadId,
  ) => {
    const requestId = randomUUID();
    await rpc(scoped(`/threads/${id}/control`, 'POST', {
      requestId,
      control: {
        action: 'permission',
        value,
        expected: catalog.state.permission,
        expectedRevision: catalog.state.permissionRevision,
      },
    }));
    await waitFor(async () => (await rpc<{ state: string }>(scoped(`/operations/${requestId}`))).state === state,
      `Antigravity permission ${value} did not become ${state}`);
  };
  const original = await read();
  const review = 'antigravity:request-review';
  const turbo = 'antigravity:turbo';
  assert.deepEqual(original.actions, ['permission']);
  assert.equal(original.state.permission, review);
  assert(!original.permissions.some((preset) => preset.id === 'antigravity:inherit'));
  assert.equal(original.state.permissionRevision?.length, 64);
  await send(turbo, original, 'rejected', switchId);
  assert.equal(fixture.calls.permissionUpdates.length, 0, 'Cross-conversation revision reached the daemon');
  await send(turbo, original, 'completed');
  const changed = await read();
  assert.equal(changed.state.permission, turbo);
  assert.notEqual(changed.state.permissionRevision, original.state.permissionRevision);
  assert.equal((await read(switchId)).state.permission, review);
  await send(review, original, 'rejected');
  fixture.setPermissionCapabilities({ adminLocked: true });
  assert.deepEqual((await read()).actions, []);
  await send(review, changed, 'rejected');
  fixture.setPermissionCapabilities({ sandbox: false });
  const noSandbox = await read();
  assert(!noSandbox.permissions.some((preset) => preset.id === 'antigravity:auto' || preset.id === 'antigravity:default'));
  await send('antigravity:auto', noSandbox, 'rejected');
  fixture.setPermissionCapabilities({ enabled: false });
  const unsupported = await read();
  assert.deepEqual(unsupported.actions, []);
  assert(unsupported.permissionUnavailableReason);
  await send(review, changed, 'rejected');
  fixture.setPermissionCapabilities({});
  await send(review, await read(), 'completed');
  assert.equal((await read()).state.permission, review);
  assert.deepEqual(fixture.calls.permissionUpdates, [
    { threadId, preset: 'AGENT_PERMISSION_PRESET_TURBO' },
    { threadId, preset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' },
  ]);
  const result = await rpc<{ thread: { title: string } }>(scoped(`/threads/${threadId}`));
  assert.equal(result.thread.title, initialTitle);
}
