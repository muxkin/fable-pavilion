import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

export type GoalView = {
  id: string;
  revision: number;
  objective: string;
  phase: string;
  activation: string;
};

export const dshModelId = (model: string) => JSON.stringify(['fixture', model]);

export const defaultDshProjections = () => ({
  modelSelection: { next: { provider: 'fixture', model: 'base' } },
  permissions: { currentValue: 'ask' },
  agentPreset: 'standard',
  plan: { active: false },
  turnOutline: [],
});

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export interface DshFixtureOptions {
  png: Buffer;
  workspacePdf: Buffer;
  sessionZip: Buffer;
}

export async function createDshFixture({ png, workspacePdf, sessionZip }: DshFixtureOptions) {
  const errors: string[] = [];
  const instances = ['dsh-one', 'dsh-two'].map((id) => ({
    id,
    token: randomBytes(16).toString('hex'),
    title: id,
    created: new Map<string, string>(),
    inbox: [] as { id: string; content: { type: string; text: string }[] }[],
    followers: new Map<WebSocket, string>(),
    controls: new Map<WebSocket, string>(),
    eventClients: new Map<WebSocket, { stream: string; peer: string; client: string }>(),
    eventSessions: 0,
    eventReplies: [] as { clientId: string; eventId: string; outcome: any }[],
    timed: new Map<string, number>(),
    releasedWaits: [] as string[],
    lostEvents: new Set<string>(),
    competingEvents: new Set<string>(),
    receipts: new Map<string, { attachmentId: string; name: string; bytes: number }>(),
    images: new Map<string, { attachment: object; data: string }>(),
    projections: new Map<string, Record<string, unknown>>([['shared', defaultDshProjections()]]),
    projectionSeq: 1,
    pageWindow: 100,
    calls: [] as { method: string; request: any }[],
    goal: null as GoalView | null,
    failCompact: false,
    records: [
      {
        event: {
          seq: 1,
          time: 123,
          type: 'assistant/message',
          data: {
            message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'Rust DSH history' }] },
          },
        },
      },
    ] as { event: Record<string, unknown> }[],
    opens: 0,
  }));
  const [one, two] = instances;
  type DshInstance = typeof one;

  const cookie = (value?: string) => instances.find(({ id }) => value?.split('; ')[0] === 'session=' + id);
  const answerPeer = (value?: string) =>
    value
      ?.split('; ')
      .find((part) => part.startsWith('answer='))
      ?.slice(7);

  function eventFrame(instance: DshInstance, value: object) {
    for (const [socket, { stream }] of instance.eventClients)
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'item', streamId: stream, value }));
  }

  function interaction(instance: DshInstance, event: string, request: object, agentId = 'shared') {
    const eventId = randomUUID();
    eventFrame(instance, { type: 'waterfall', event, eventId, agentId, request });
    return eventId;
  }

  function baseline(instance: DshInstance, id: string) {
    return {
      values: instance.projections.get(id),
      asOfSeq: Math.max(instance.records.length, instance.projectionSeq),
    };
  }

  function projectionFrame(instance: DshInstance, value: object) {
    for (const [socket, streamId] of instance.controls)
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'item', streamId, value }));
  }

  function project(instance: DshInstance, sessionId: string, key: string, value: unknown, publish = true) {
    const projections = instance.projections.get(sessionId);
    assert(projections);
    projections[key] = value;
    instance.projectionSeq = Math.max(instance.records.length, instance.projectionSeq) + 1;
    if (publish)
      projectionFrame(instance, { type: 'projection', sessionId, key, value, seq: instance.projectionSeq });
  }

  function push(instance: DshInstance, value: object) {
    for (const [socket, streamId] of instance.followers)
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'item', streamId, value }));
  }

  function record(instance: DshInstance, type: string, data: object, publish = true) {
    const event = { type, data, seq: instance.records.length + 1, time: Date.now() };
    instance.records.push({ event });
    if (publish) push(instance, { type: 'event', event });
  }

  function user(instance: DshInstance, turn: number, requestId: string, text: string) {
    record(instance, 'user/message', {
      turn,
      id: requestId,
      role: 'user',
      source: { kind: 'user', rpcId: requestId },
      content: [{ type: 'text', text }],
    });
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url!, 'http://localhost');
    if (path.pathname === '/connect') {
      const instance = instances.find(({ token }) => path.searchParams.get('token') === token);
      if (!instance) return response.writeHead(403).end();
      const mode = path.searchParams.get('interactions');
      assert(mode === 'none' || mode === 'answer');
      const cookies = ['session=' + instance.id];
      if (mode === 'answer') {
        instance.eventSessions++;
        cookies.push('answer=' + randomUUID());
      }
      return response.writeHead(302, { Location: '/api/remote.mux', 'Set-Cookie': cookies }).end();
    }
    const instance = cookie(request.headers.cookie);
    if (!instance) return response.writeHead(403).end();
    if (path.pathname === '/api/session.export') {
      assert.equal(request.method, 'GET');
      assert.equal(path.searchParams.get('includeDescendants'), 'true');
      if (path.searchParams.get('sessionId') !== 'shared') return response.writeHead(404).end();
      return response.writeHead(200, { 'content-type': 'application/zip' }).end(sessionZip);
    }
    if (path.pathname === '/api/file') {
      assert.equal(instance, one);
      assert.equal(path.searchParams.get('path'), '/fixture/report copy.pdf');
      assert.equal(request.method, 'GET');
      instance.calls.push({ method: '/api/file', request: path.searchParams.get('path') });
      return response.end(workspacePdf);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (path.pathname === '/api/session/uploadFileBinary') {
      assert.equal(request.headers['content-type'], 'application/octet-stream');
      assert.equal(Number(request.headers['content-length']), body.length);
      assert.equal(path.searchParams.get('sessionId'), 'shared');
      const name = path.searchParams.get('name')!;
      const file = { attachmentId: 'sha256:' + sha256(body), name, bytes: body.length };
      const receiptId = randomUUID();
      instance.receipts.set(receiptId, file);
      if (name === 'race.txt') {
        record(instance, 'turn/start', { turn: 21 });
        await delay(300);
      }
      instance.calls.push({ method: 'session/uploadFileBinary', request: file });
      return response.end(JSON.stringify({ ok: true, value: { receiptId, file } }));
    }
    const rpc = JSON.parse(body.toString());
    assert.equal(path.pathname, '/api/' + rpc.method);
    const args = rpc.payload.args.request ?? rpc.payload.args;
    let value;
    switch (rpc.method) {
      case 'skills/list':
        assert.equal(args.sessionId, 'shared');
        value = {
          skills:
            instance === one
              ? [{ name: 'fixture-skill', description: 'Fixture skill', modelInvocable: false }]
              : [],
        };
        break;
      case 'goals/get':
        assert.equal(args.agentId, 'shared');
        value = instance.goal ?? undefined;
        break;
      case 'goals/create':
      case 'goals/edit':
      case 'goals/pause':
      case 'goals/resume':
      case 'goals/complete':
      case 'goals/clear': {
        assert.equal(instance, one);
        const { agentId, ref, request: goalRequest } = rpc.payload.args;
        assert.equal(agentId, 'shared');
        if (rpc.method === 'goals/create') {
          assert.equal(ref, undefined);
          instance.goal = {
            id: 'goal-' + randomUUID(),
            revision: 1,
            objective: goalRequest.objective,
            phase: 'active',
            activation: 'armed',
          };
          value = { ref: { id: instance.goal.id, revision: instance.goal.revision } };
        } else {
          const current = instance.goal!;
          assert.deepEqual(ref, { id: current.id, revision: current.revision });
          const next = { ...current, revision: current.revision + 1 };
          if (rpc.method === 'goals/edit') next.objective = goalRequest.objective;
          if (rpc.method === 'goals/pause') {
            next.phase = 'paused';
            next.activation = 'disarmed';
          }
          if (rpc.method === 'goals/resume') {
            next.phase = 'active';
            next.activation = 'armed';
          }
          if (rpc.method === 'goals/complete') {
            next.phase = 'complete';
            next.activation = 'disarmed';
          }
          if (rpc.method === 'goals/clear') {
            value = { id: next.id, revision: next.revision };
            instance.goal = null;
          } else {
            instance.goal = next;
            value = next;
          }
          if (goalRequest?.objective === 'lost goal response') {
            instance.calls.push({ method: rpc.method, request: args });
            return response.destroy();
          }
        }
        break;
      }
      case 'sessionFeedback/record':
        assert.equal(instance, one);
        assert.deepEqual(args, { sessionId: 'shared', text: 'Fixture feedback' });
        value = { ok: true, value: {} };
        break;
      case '$events/result':
        assert(
          [...instance.eventClients.values()].some(
            (binding) =>
              binding.client === args.clientId && binding.peer === answerPeer(request.headers.cookie),
          ),
        );
        instance.eventReplies.push(args);
        if (instance.lostEvents.delete(args.eventId)) return response.destroy();
        if (instance.competingEvents.delete(args.eventId)) {
          eventFrame(instance, { type: 'cancel', eventId: args.eventId });
          await delay(250);
        }
        break;
      case 'userQuestions/answer': {
        assert.equal(args.agentId, 'shared');
        assert(answerPeer(request.headers.cookie));
        const question = instance.projections.get('shared')?.userQuestions as { active: { callId: string }[] };
        const active = question.active.filter((entry) => entry.callId !== args.callId);
        value = active.length !== question.active.length;
        if (value) project(instance, 'shared', 'userQuestions', { active, settled: [] });
        break;
      }
      case 'session/page': {
        assert.deepEqual(args.address, { kind: 'session', sessionId: 'shared' });
        const earlier = instance.records.filter(
          ({ event }) => Number(event.seq) < args.beforeSeq && Number(event.seq) <= args.throughSeq,
        );
        value = { records: earlier.slice(-instance.pageWindow), hasMore: earlier.length > instance.pageWindow };
        break;
      }
      case 'fileReferences/list':
        assert.deepEqual(args, { agentId: 'shared', query: 'report' });
        value = [{ path: 'report copy.pdf' }];
        break;
      case 'session/attachment':
        assert.equal(args.sessionId, 'shared');
        value = instance.images.get(args.attachmentId);
        if (!value)
          return response.end(
            JSON.stringify({
              type: 'server-response',
              rpcId: rpc.rpcId,
              result: { ok: false, error: { code: 'session/attachment-invalid' } },
            }),
          );
        break;
      case 'session/list':
        value = {
          items: [
            { sessionId: 'shared', updatedAt: 123, projections: { values: { title: instance.title } } },
            ...[...instance.created].map(([sessionId, title]) => ({
              sessionId,
              updatedAt: 124,
              projections: { values: { title } },
            })),
          ],
        };
        break;
      case 'session/create': {
        assert.equal(args.workspaceId, 'work-' + instance.id);
        const id = 'created-' + args.sessionId;
        instance.created.set(id, '新会话');
        instance.projections.set(id, { ...defaultDshProjections(), agentPreset: args.agentPreset ?? 'standard' });
        value = { sessionId: id };
        break;
      }
      case 'session/projections':
        assert(instance.projections.has(args.sessionId));
        value = { kind: 'sequenced', ...baseline(instance, args.sessionId) };
        break;
      case 'session/modelCatalog':
        assert.deepEqual(args, {});
        value = {
          groups: [
            {
              id: 'fixture',
              name: 'Fixture',
              models: [
                { id: 'base', name: 'Base' },
                {
                  id: 'advanced',
                  name: 'Advanced',
                  reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' },
                },
                { id: 'drop', name: 'Drop response' },
              ],
            },
          ],
        };
        break;
      case 'session/selectModel': {
        const { sessionId, ...selected } = args;
        assert.equal(selected.provider, 'fixture');
        project(instance, sessionId, 'modelSelection', { next: selected });
        if (selected.model === 'drop') {
          instance.calls.push({ method: rpc.method, request: args });
          return response.destroy();
        }
        value = { selected };
        break;
      }
      case 'permissionPresets/catalog':
        assert.deepEqual(args, {});
        value = {
          defaultPreset: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'restricted', name: 'Restricted' },
            { value: 'ask\n/plan', name: 'Invalid preset identifier' },
          ],
        };
        break;
      case 'agentPresets/list':
        value = {
          presets: [
            { id: 'standard', isDefault: true },
            { id: 'custom', isDefault: false },
            { id: 'broken', isDefault: false, broken: 'unavailable' },
          ],
        };
        break;
      case 'agentPresets/select':
        assert.equal(args.agentPreset, 'custom');
        project(instance, args.agentId, 'agentPreset', args.agentPreset);
        value = args.agentPreset;
        break;
      case 'commands/list':
        assert(instance.projections.has(args.agentId));
        value = [
          'permission',
          'plan',
          ...(instance === one && args.agentId === 'shared' ? ['compact', 'feedback', 'goal'] : []),
        ].map((name) => ({ name }));
        break;
      case 'commands/execute':
        assert.deepEqual(args.submittedAttachments, []);
        if (args.line === '/compact') {
          const commandId = randomUUID();
          const kind = instance.failCompact ? 'error' : 'success';
          instance.failCompact = false;
          record(instance, 'command/run', { commandId, name: 'compact', args: '' });
          record(instance, 'command/done', {
            commandId,
            kind,
            text: kind === 'success' ? 'Compacted' : 'Fixture failure',
          });
          value = { commandId, result: { kind } };
          break;
        } else if (args.line === '/permission restricted' || args.line === '/permission ask') {
          project(instance, args.agentId, 'permissions', { currentValue: args.line.split(' ')[1] });
        } else {
          assert(['/plan', '/plan off'].includes(args.line));
          project(instance, args.agentId, 'plan', { active: args.line === '/plan' });
        }
        value = { commandId: randomUUID(), result: { kind: 'success' } };
        break;
      case 'session/prompt':
        assert(args.sessionId === 'shared' || instance.created.has(args.sessionId));
        if (['lost response', 'lost initial response'].includes(args.content[0].text)) {
          instance.calls.push({ method: rpc.method, request: args });
          return response.destroy();
        }
        if (args.content[0].text === 'queued') {
          const queued = { id: 'queue-' + args.requestId, content: args.content };
          const start = instance.inbox.length;
          instance.inbox.push(queued);
          record(instance, 'agent/inbox/spliced', { target: 'next-turn', start, inserted: [queued] });
        }
        if (args.content.some((part: any) => part.type === 'file' || part.type === 'image')) {
          const content = args.content.map((part: any) => {
            if (part.type === 'file') {
              const attachment = instance.receipts.get(part.receiptId);
              assert(attachment);
              return { type: 'file', attachment };
            }
            if (part.type === 'image') {
              assert.equal(part.mediaType, 'image/png');
              assert.deepEqual(Buffer.from(part.data, 'base64'), png);
              const attachment = {
                attachmentId: 'sha256:' + sha256(png),
                mediaType: 'image/png',
                bytes: png.length,
                name: part.name,
              };
              instance.images.set(attachment.attachmentId, { attachment, data: part.data });
              return { type: 'image', attachment };
            }
            return part;
          });
          record(instance, 'assistant/message', {
            message: { id: args.requestId, role: 'assistant', content },
          });
        }
        value = { accepted: true };
        break;
      case 'session/updateQueue': {
        assert.deepEqual(args.action, { kind: 'remove' });
        const start = instance.inbox.findIndex((item) => item.id === args.itemId);
        assert(start >= 0);
        instance.inbox.splice(start, 1);
        record(instance, 'agent/inbox/spliced', {
          target: 'next-turn',
          start,
          removedCount: 1,
          inserted: [],
          outcome: 'canceled',
        });
        value = { accepted: true };
        break;
      }
      case 'session/cancel':
        assert.deepEqual(args, { sessionId: 'shared' });
        record(instance, 'turn/end', { turn: 8, reason: { kind: 'interrupted' } });
        await delay(300); // The event can reach the relay before the acknowledgement.
        value = { accepted: true };
        break;
      case 'session/rename':
        if (args.sessionId === 'shared') {
          instance.title = args.title;
          record(instance, 'session/title', { title: args.title });
        } else {
          assert(instance.created.has(args.sessionId));
          instance.created.set(args.sessionId, args.title);
        }
        value = { title: args.title, seq: instance.records.length };
        break;
      default:
        assert.fail('Unexpected DSH RPC ' + rpc.method);
    }
    instance.calls.push({ method: rpc.method, request: args });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
  }

  const server = createServer((request, response) => {
    void handleHttp(request, response).catch((error) => {
      errors.push(`HTTP ${request.url ?? ''}: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'fixture-error' }));
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });

  const wsServer = new WebSocketServer({ server, path: '/api/remote.mux' });
  wsServer.on('connection', (socket, request) => {
    const instance = cookie(request.headers.cookie);
    if (!instance) {
      errors.push('DSH WebSocket connected without a valid session cookie');
      socket.close(1008);
      return;
    }
    const waits = new Map<string, string>();
    socket.on('message', (buffer) => {
      try {
        const frame = JSON.parse(buffer.toString());
        if (frame.type === 'cancel' && waits.has(frame.streamId)) {
          instance.releasedWaits.push(waits.get(frame.streamId)!);
          waits.delete(frame.streamId);
          return;
        }
        if (frame.type !== 'open') return;
        if (frame.endpoint === '$events') {
          const peer = answerPeer(request.headers.cookie);
          assert(peer);
          assert.deepEqual(frame.payload, { args: {} });
          const client = randomUUID();
          instance.eventClients.set(socket, { stream: frame.streamId, peer, client });
          socket.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'ready',
                clientId: client,
                host: { home: '/fixture' },
              },
            }),
          );
          return;
        }
        if (frame.endpoint === 'userQuestions/attachWait') {
          assert(instance.eventClients.has(socket));
          const { agentId, callId } = frame.payload.args;
          assert.equal(agentId, 'shared');
          const remainingMs = instance.timed.get(callId);
          assert(remainingMs !== undefined);
          waits.set(frame.streamId, callId);
          socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { remainingMs } }));
          return;
        }
        if (frame.endpoint === 'workspace/follow') {
          socket.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'baseline',
                value: {
                  items: [
                    {
                      workspaceId: 'work-' + instance.id,
                      title: 'Workspace ' + instance.id,
                      path: '/fixture',
                      sessionIds: ['shared', ...instance.created.keys()],
                    },
                  ],
                },
              },
            }),
          );
          return;
        }
        if (frame.endpoint === 'session/control') {
          assert.deepEqual(frame.payload.args, {});
          instance.controls.set(socket, frame.streamId);
          socket.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'baseline',
                value: {
                  projections: Object.fromEntries(
                    [...instance.projections.keys()].map((id) => [id, baseline(instance, id)]),
                  ),
                },
              },
            }),
          );
          return;
        }
        assert.equal(frame.endpoint, 'session/follow');
        const id = frame.payload.args.request.address.sessionId;
        const isShared = id === 'shared';
        assert(isShared || instance.created.has(id));
        assert.equal(frame.payload.args.request.address.kind, 'session');
        socket.send(
          JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'snapshot',
              header: { id, version: 4, cwd: '/fixture', createdAt: 123 },
              projections: {
                ...baseline(instance, id),
                values: {
                  ...instance.projections.get(id),
                  title: isShared ? instance.title : instance.created.get(id),
                  inbox: { 'next-turn': isShared ? instance.inbox : [], 'next-step': [] },
                },
              },
              cursor: isShared ? instance.records.length : -1,
              hasMore: isShared && instance.records.length > instance.pageWindow,
              records: isShared ? instance.records.slice(-instance.pageWindow) : [],
            },
          }),
        );
        if (frame.payload.args.request.assistantStream) {
          instance.opens++;
          instance.followers.set(socket, frame.streamId);
        }
      } catch (error) {
        errors.push(`WS(${instance.id}): ${error instanceof Error ? error.message : String(error)}`);
        socket.close(1011);
      }
    });
    socket.once('close', () => {
      instance.followers.delete(socket);
      instance.controls.delete(socket);
      instance.eventClients.delete(socket);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const carrier = server.address();
  assert(carrier && typeof carrier !== 'string');
  const url = 'http://127.0.0.1:' + carrier.port;

  return {
    url,
    instances,
    one,
    two,
    errors,
    eventFrame,
    interaction,
    projectionFrame,
    project,
    push,
    record,
    user,
    async close() {
      for (const socket of wsServer.clients) socket.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
