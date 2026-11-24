import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { encodeFrame, FrameReader } from '../../../packages/adapter-codex/src/framing.js';

export const MODERN_CODEX = {
  id: 'codex-modern',
  title: '新版 Codex 测试会话',
  otherThreadId: '10000000-0000-4000-8000-000000000003',
};

export async function createModernCodexFixture(directory: string, threadId: string, rollout: string) {
  const path =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\agent-space-native-test-' + crypto.randomUUID()
      : join(directory, 'modern-tools.sock');
  const sockets = new Set<Socket>();
  const errors: string[] = [];
  const sends: { callId: string; prompt: string; activeTurnId?: string }[] = [];
  const navCalls: string[] = [];
  const time = 1_800_000_000_000;
  let status: 'notLoaded' | 'idle' | 'active' = 'notLoaded';
  let activeTurnId: string | undefined;
  let activeFlags: string[] = [];
  let wrongAcknowledgement = false;

  // This server speaks only app-tools. The fixture's configured follower socket does not exist.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const frames = new FrameReader();
    socket.on('data', (chunk) => {
      try {
        frames.push(chunk, (call) => {
          const reply = (result: unknown) => socket.write(encodeFrame({ id: call.id, result }));
          if (call.method === 'tools/list') {
            reply({
              tools: ['navigate_to_codex_page', 'read_thread', 'send_message_to_thread'].map((name) => ({
                namespace: 'codex_app',
                name,
              })),
            });
            return;
          }
          assert.equal(call.method, 'tools/call');
          const { tool, callId, arguments: args } = call.params;
          const otherThread = tool === 'read_thread' && args.threadId === MODERN_CODEX.otherThreadId;
          const target = otherThread ? MODERN_CODEX.otherThreadId : threadId;
          assert.equal(call.params.threadId, target);
          assert.equal(call.params.hostId, 'local');
          assert.equal(args.threadId, target);
          let result: unknown;
          switch (tool) {
            case 'navigate_to_codex_page':
              assert.equal(args.hostId ?? 'local', 'local');
              navCalls.push(callId);
              status = 'idle';
              break;
            case 'read_thread':
              assert.deepEqual(
                args,
                args.includeTurns
                  ? {
                      threadId: target,
                      hostId: 'local',
                      includeTurns: true,
                      turnLimit: 1,
                      includeOutputs: false,
                      maxOutputCharsPerItem: 0,
                    }
                  : { threadId: target, hostId: 'local', includeTurns: false },
              );
              result = {
                schemaVersion: 1,
                thread: {
                  id: target,
                  kind: 'codex',
                  hostId: 'local',
                  status: otherThread ? { type: 'notLoaded' } : {
                    type: status,
                    ...(status === 'active' && { activeFlags }),
                  },
                  title: MODERN_CODEX.title,
                  cwd: directory,
                  createdAt: time,
                  updatedAt: time,
                },
                turns:
                  !otherThread && args.includeTurns && status === 'active' && activeTurnId
                    ? [{ id: activeTurnId, status: 'inProgress' }]
                    : [],
                ...(args.includeTurns && { page: { order: 'newest_first' } }),
              };
              break;
            case 'send_message_to_thread':
              if (status === 'active') {
                assert(activeTurnId, 'Fixture received a follow-up without an active turn');
                assert.equal(activeFlags.length, 0, 'Fixture received a follow-up with a pending request');
              }
              assert.deepEqual(Object.keys(args).sort(), ['hostId', 'prompt', 'threadId']);
              assert.equal(args.hostId, 'local');
              assert.equal(typeof args.prompt, 'string');
              sends.push({
                callId,
                prompt: args.prompt,
                activeTurnId: status === 'active' ? activeTurnId : undefined,
              });
              const escaped = args.prompt
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;');
              appendFileSync(
                rollout,
                JSON.stringify({
                  type: 'event_msg',
                  payload: {
                    type: 'item_completed',
                    thread_id: threadId,
                    turn_id: (status === 'active' && activeTurnId) || crypto.randomUUID(),
                    item: {
                      type: 'FunctionCallOutput',
                      id: crypto.randomUUID(),
                      namespace: 'codex_app',
                      name: tool,
                      output: `<codex_delegation><source_thread_id>${threadId}</source_thread_id><input>${escaped}</input></codex_delegation>`,
                    },
                  },
                }) + '\n',
              );
              result = { threadId: wrongAcknowledgement ? crypto.randomUUID() : threadId };
              wrongAcknowledgement = false;
              break;
            default:
              assert.fail(`Unexpected Codex app tool: ${tool}`);
          }
          reply({
            success: true,
            contentItems: result === undefined ? [] : [{ type: 'inputText', text: JSON.stringify(result) }],
          });
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        socket.destroy();
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  if (process.platform !== 'win32') await chmod(path, 0o600);

  return {
    path,
    errors,
    sends,
    navCalls,
    setStatus: (value: typeof status) => {
      status = value;
      activeTurnId = undefined;
      activeFlags = [];
    },
    setActiveTurn: (id: string, flags: string[] = []) => {
      status = 'active';
      activeTurnId = id;
      activeFlags = flags;
    },
    mismatchNextAcknowledgement: () => {
      wrongAcknowledgement = true;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type ModernCodexFixture = Awaited<ReturnType<typeof createModernCodexFixture>>;
