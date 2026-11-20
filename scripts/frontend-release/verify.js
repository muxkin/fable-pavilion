// Shared by the trusted Pages worker and the release build checks.
const publicFiles = /^\/[a-zA-Z0-9_.@+-]+(?:\/[a-zA-Z0-9_.@+-]+)*$/;
const identifier = /^[a-f0-9]{64}$/;
const from64 = (value) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
const hex = (value) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

function validFile(path) {
  return (
    publicFiles.test(path) &&
    path.split('/').every((part) => part !== '.' && part !== '..') &&
    !/^\/(?:_release(?:\/|$)|verified-(?:start|worker)\.js$)/.test(path)
  );
}

async function verifyRelease(document, publicKey, now = Date.now()) {
  const content = from64(document.manifest);
  const key = await crypto.subtle.importKey(
    'spki',
    from64(publicKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, from64(document.signature), content)))
    throw Error('Invalid release signature');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  if (
    manifest.schema !== 1 ||
    !Number.isSafeInteger(manifest.version) ||
    manifest.version <= 0 ||
    !Number.isSafeInteger(manifest.expires) ||
    manifest.expires <= now ||
    !manifest.files ||
    !Object.hasOwn(manifest.files, '/index.html') ||
    Object.entries(manifest.files).some(([path, hash]) => !validFile(path) || !identifier.test(hash))
  )
    throw Error('Invalid or expired release');
  return { ...manifest, id: await digest(content) };
}

globalThis.frontendRelease = { digest, validFile, verifyRelease };
