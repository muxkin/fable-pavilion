/** Disposable paired browser connection for the existing signed native updater acceptance. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeSession } from '../../src/client/node-session.js';
import { buildRelay } from '../../src/server/relay.js';
import { platformRuntime } from '../../src/server/platform.js';
import { createIdentity } from '../../src/shared/secure-channel.js';

export async function updateNoiseFixture(directory: string) {
  const phone = await createIdentity();
  const enrollment = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const relay = await buildRelay({
    origin,
    enrollmentSecret: enrollment,
    webRoot: join(directory, 'no-web'),
    assetOrigin: null,
    uploadOrigins: [],
  });
  type Link = Awaited<ReturnType<typeof nodeSession>>;
  let paired: { hostId: string; deviceId: string; ticket: string } | undefined;
  let current: Link | undefined;
  let first: Link | undefined;
  let handoff = false;
  let stopped = false;
  let failure: Error | undefined;
  let connections = 0;
  let pingsBefore = 0;
  let pingsAfter = 0;
  let heartbeat: Promise<void> | undefined;

  async function connect() {
    assert(paired);
    const link = await nodeSession(origin, paired.hostId, phone, paired.ticket, {
      type: 'authenticate', protocol: 2, sessionId: randomUUID(),
    });
    const ready = await link.ready;
    assert.equal(ready.device.id, paired.deviceId, 'Updated adapter changed the paired device');
    assert.equal(ready.ticket, paired.ticket, 'Updated adapter changed the route ticket');
    connections += 1;
    return link;
  }

  async function ping(link: Link) {
    assert.deepEqual((await link.request('ping', {}, undefined, 5_000)).value, { ok: true });
    if (link === first) pingsBefore += 1;
    else pingsAfter += 1;
  }

  async function keepOpen() {
    while (!stopped) {
      try {
        assert(current);
        await ping(current);
      } catch {
        if (stopped) return;
        if (!handoff) {
          failure = Error('Paired read-only Noise connection closed before the updater handoff');
          return;
        }
        // Reuse the original identity and route ticket, exactly as an already open PWA does.
        try { current = await connect(); }
        catch { await delay(500); }
      }
      await delay(250);
    }
  }

  relay.app.post('/qa/update-noise', async (request, reply) => {
    if (request.headers['x-native-update-qa'] !== token) return reply.code(403).send({ ok: false });
    const body = request.body as Record<string, unknown>;
    try {
      if (failure) throw failure;
      switch (body.action) {
        case 'connect': {
          assert(!paired, 'Noise update fixture was already paired');
          assert(typeof body.hostId === 'string' && typeof body.deviceId === 'string' && typeof body.ticket === 'string');
          paired = { hostId: body.hostId, deviceId: body.deviceId, ticket: body.ticket };
          current = first = await connect();
          first.onClose(() => {
            if (!stopped && !handoff) failure = Error('Noise connection closed before the updater handoff');
          });
          await ping(first);
          heartbeat = keepOpen();
          return { ok: true };
        }
        case 'handoff':
          assert(first && current === first && !first.closed, 'Updater required the passive browser connection to close');
          await ping(first);
          assert(!first.closed && !failure, 'Noise connection did not survive the update drain');
          handoff = true;
          return { ok: true };
        case 'reconnected':
          return { ok: Boolean(handoff && connections >= 2 && pingsAfter > 0 && current && !current.closed) };
        default:
          return reply.code(400).send({ ok: false });
      }
    } catch {
      // Keep all fixture identity/ticket material out of failure output.
      return reply.code(409).send({ ok: false });
    }
  });
  await relay.app.listen({ host: '127.0.0.1', port });
  const env = {
    POCKET_QA_NOISE_ORIGIN: origin,
    POCKET_QA_NOISE_ENROLLMENT: enrollment,
    POCKET_QA_NOISE_PEER: phone.peerId,
    POCKET_QA_NOISE_TOKEN: token,
  };
  const configuration = join(directory, 'update-noise-fixture.json');
  await writeFile(configuration, JSON.stringify(env), { flag: 'wx', mode: 0o600 });
  platformRuntime().privateFile(configuration);
  return {
    configuration,
    env,
    assertComplete() {
      assert.ifError(failure);
      assert(handoff && connections >= 2 && pingsBefore >= 2 && pingsAfter > 0,
        'Signed updater did not preserve an open paired browser through handoff and reconnect');
      console.log('Paired read-only Noise stayed open until adapter handoff and reconnected with the original ticket.');
    },
    async close() {
      stopped = true;
      current?.close();
      await relay.app.close();
      await heartbeat;
    },
  };
}
