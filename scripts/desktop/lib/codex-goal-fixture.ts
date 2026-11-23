import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

interface FixtureGoal {
  threadId: string;
  objective: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

export async function createCodexGoalFixture(home: string, threadId: string) {
  const control = join(home, 'app-server-control');
  const path = join(control, 'app-server-control.sock');
  await mkdir(control, { mode: 0o700, recursive: true });
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const errors: string[] = [];
  const mutations: { method: string; params: Record<string, unknown> }[] = [];
  let reportedHome = home;
  let ownerPresent = true;
  let goal: FixtureGoal | null = null;
  let timestamp = 1_800_000_000;

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (peer) => sockets.emit('connection', peer));
  });
  sockets.on('connection', (peer) => {
    let initialized = false;
    peer.on('error', () => {});
    peer.on('message', (data, binary) => {
      try {
        assert(!binary);
        const call = JSON.parse(data.toString());
        const reply = (result: unknown) => peer.send(JSON.stringify({ id: call.id, result }));
        if (call.method === 'initialize') {
          assert.equal(call.params.capabilities.experimentalApi, true);
          reply({ userAgent: 'fixture/999.0.0', codexHome: reportedHome });
          return;
        }
        if (call.method === 'initialized') {
          initialized = true;
          return;
        }
        assert(initialized);
        switch (call.method) {
          case 'thread/loaded/list':
            if (call.params.cursor === undefined) {
              assert.deepEqual(call.params, {});
              reply({ data: ['f14c049e-f3f7-4ceb-9711-2a2d8bd9839e'], nextCursor: 'fixture-owner-page' });
            } else {
              assert.deepEqual(call.params, { cursor: 'fixture-owner-page' });
              reply({ data: ownerPresent ? [threadId] : [], nextCursor: null });
            }
            break;
          case 'thread/goal/get':
            assert(ownerPresent && reportedHome === home);
            assert.deepEqual(call.params, { threadId });
            reply({ goal });
            break;
          case 'thread/goal/set': {
            assert(ownerPresent && reportedHome === home);
            assert.equal(call.params.origin, 'user');
            assert.equal(call.params.threadId, threadId);
            const objective = call.params.objective ?? goal?.objective;
            assert.equal(typeof objective, 'string');
            goal = {
              threadId,
              objective,
              status: call.params.status ?? goal?.status ?? 'active',
              createdAt: goal?.createdAt ?? timestamp,
              updatedAt: ++timestamp,
              tokenBudget: goal?.tokenBudget ?? null,
              tokensUsed: goal?.tokensUsed ?? 0,
              timeUsedSeconds: goal?.timeUsedSeconds ?? 0,
            };
            mutations.push({ method: call.method, params: call.params });
            reply({ goal });
            break;
          }
          case 'thread/goal/clear':
            assert(ownerPresent && reportedHome === home);
            assert.deepEqual(call.params, { threadId, origin: 'user' });
            goal = null;
            mutations.push({ method: call.method, params: call.params });
            reply({ cleared: true });
            break;
          default:
            assert.fail(`Unexpected Codex goal method: ${call.method}`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        peer.terminate();
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  await chmod(path, 0o600);

  return {
    errors,
    mutations,
    snapshot: () => goal,
    account: (tokensUsed: number, timeUsedSeconds: number) => {
      assert(goal);
      goal = { ...goal, updatedAt: ++timestamp, tokensUsed, timeUsedSeconds };
    },
    setOwnerPresent: (present: boolean) => {
      ownerPresent = present;
    },
    setHomeMatches: (matches: boolean) => {
      reportedHome = matches ? home : dirname(home);
    },
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => sockets.close(() => resolve())),
      ]);
    },
  };
}

export type CodexGoalFixture = Awaited<ReturnType<typeof createCodexGoalFixture>>;
