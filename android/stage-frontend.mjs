import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import '../scripts/frontend-release/verify.js';

const [source, keyFile, target] = process.argv.slice(2);
const { digest, verifyRelease } = globalThis.frontendRelease;
const key = createPublicKey(await readFile(keyFile))
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
const document = await readFile(join(source, 'manifest.json'));
const release = await verifyRelease(JSON.parse(document), key);

await mkdir(join(target, 'assets'), { recursive: true });
const assets = new Set(
  Object.entries(release.files)
    .filter(([path]) => !(path.startsWith('/downloads/android/') && path.endsWith('.apk')))
    .map(([, checksum]) => checksum),
);
for (const checksum of assets) {
  const filename = checksum + '.bin';
  const bytes = await readFile(join(source, 'assets', filename));
  if ((await digest(bytes)) !== checksum) throw Error('Bundled release asset failed verification');
  await writeFile(join(target, 'assets', filename), bytes);
}
await writeFile(join(target, 'manifest.json'), document);
console.log(`Embedded verified frontend release ${release.version} (${assets.size} assets)`);
