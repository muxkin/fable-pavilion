import { afterEach } from 'vitest';
import { buildRelay } from '../src/server/relay.js';
import { anonymousAccessContract } from './contracts/anonymous-access.js';

let relay: Awaited<ReturnType<typeof buildRelay>> | undefined;
afterEach(async () => {
  await relay?.app.close();
  relay = undefined;
});
anonymousAccessContract(async (path, init = {}) => {
  relay ??= await buildRelay({
    origin: 'https://access.test',
    enrollmentSecret: 'anonymous-access-test-enrollment-secret',
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
  });
  const result = await relay.app.inject({
    method: (init.method ?? 'GET') as 'GET',
    url: `/api/im${path}`,
    headers: {
      host: 'access.test',
      origin: 'https://access.test',
      ...Object.fromEntries(new Headers(init.headers)),
    },
    payload: init.body as string | undefined,
  });
  return new Response(new Uint8Array(result.rawPayload), {
    status: result.statusCode,
    headers: result.headers as Record<string, string>,
  });
});
