import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [input = 'dist/admin', output = 'dist/admin-pages'] = process.argv.slice(2).map((p) => resolve(p));

const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  X-Robots-Tag: noindex, nofollow
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
  Cache-Control: no-cache
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`;

const routeMap = {
  version: 1,
  include: ['/api/*', '/health'],
  exclude: [],
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(input, output, { recursive: true });
await writeFile(join(output, '_headers'), headers);
await writeFile(join(output, '_routes.json'), JSON.stringify(routeMap, null, 2) + '\n');
await cp(join(here, 'proxy.js'), join(output, '_worker.js'));
console.log(`Admin Pages bundle ready at ${output}`);
