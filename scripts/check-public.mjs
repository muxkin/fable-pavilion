/** Inspect the staged Git tree, never print credential values or private configuration. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const git = (args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const files = git(['ls-files', '--cached', '-z']).toString().split('\0').filter(Boolean);
const privateValues = new Set([homedir()]);
try {
  const config = parseEnv(readFileSync(resolve(process.env.POCKET_ENV_FILE || 'local/gateway.env'), 'utf8'));
  for (const [key, value] of Object.entries(config)) {
    if (
      /(?:ACCESS_KEY|SECRET_KEY|TOKEN|PASSWORD|ENROLLMENT|ORIGIN|ASSET_BASE|STATE_DIR|STUN_URLS|BUCKET|ADAPTER)$/.test(
        key,
      ) &&
      value.length >= (/(?:BUCKET|ADAPTER)$/.test(key) ? 4 : 8) &&
      !/^(?:https?:\/\/)?[^/]*example\.(?:com|org|net)/i.test(value)
    )
      privateValues.add(value);
    if (/STUN_URLS$/.test(key)) {
      for (const address of value.split(',')) {
        const host = address.match(/^stuns?:([^:]+)(?::\d+)?$/)?.[1];
        if (host && !/(^|\.)example\.(com|org|net)$/.test(host)) privateValues.add(host);
      }
    }
    if (/ORIGIN|ASSET_BASE/.test(key)) {
      try {
        const host = new URL(value).hostname;
        if (!/^(?:localhost|127\.0\.0\.1)$/.test(host) && !/(^|\.)example\.(com|org|net)$/.test(host))
          privateValues.add(host);
      } catch {
        /* Optional empty values are not URLs. */
      }
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const forbidden =
  /(^|\/)(?:AGENTS\.md|local|inner|\.deploy|\.implementation|\.test-output|relay-state|node_modules|dist|coverage|\.npmrc|\.netrc|\.ssh|\.aws|\.env(?:\.[^/]+)?|[^/]+\.env|[^/]+\.(?:pem|key|p12|pfx|p8)|id_rsa|id_ed25519|known_hosts|ssh_config)(\/|$)|\.(?:sqlite(?:-[\w-]+)?|db(?:-[\w-]+)?|log|har|map)$/i;
const docLeakPattern =
  /\b(?:calcblog|CALCBLOG_AI_AUTO_LOG|tailscale|Remote-Agent-Control)\b|local\/native-account-release|\.implementation\/|本会话未提供/i;
const personalSitePattern = /\b(?:kai\x6doe|maomao\x67ao)\b/i;
const buildIgnoreFiles = new Set(['android/.gitignore', 'desktop/native/.gitignore']);
const smokeIndex = [
  ...files.filter((file) => file === 'package.json' || file.startsWith('.github/workflows/')),
]
  .map((file) => git(['show', `:${file}`]).toString('utf8'))
  .join('\n');
const findings = [];
for (const file of files) {
  if (
    (file !== '.env.example' && forbidden.test(file)) ||
    file.startsWith('docs/design/') ||
    file.startsWith('assets/design/') ||
    file.startsWith('src/web/public/support/') ||
    file.startsWith('src/web/public/downloads/android/')
  )
    findings.push([file, 'private or generated path']);
  if (/^docs\/[^/]+\.md$/i.test(file) && file !== 'docs/README.md')
    findings.push([file, 'place docs under docs/{guide,deploy,dev}/ instead of flat docs/ root']);
  if (/^scripts\/(?!lib\/).*-smoke\.[^/]+$/.test(file) && !smokeIndex.includes(file))
    findings.push([file, 'unreferenced smoke script must be wired into package.json or CI']);
  const bytes = git(['show', `:${file}`]);
  if (/\.(png|webp|jpg|jpeg|ico|icns|woff2?)$/i.test(file)) continue;
  const content = bytes.toString('utf8');
  // Build-output ignore files are allowed only in their declared directories; other ignore files stay local.
  if (file.endsWith('/.gitignore') && !buildIgnoreFiles.has(file))
    findings.push([file, 'local ignore file must remain local']);
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/.test(
      content,
    )
  )
    findings.push([file, 'credential pattern']);
  if ((/\.(?:md|txt)$/i.test(file) || file === '.env.example') && docLeakPattern.test(content))
    findings.push([file, 'private or internal documentation detail']);
  if (file !== 'scripts/check-public.mjs' && personalSitePattern.test(content))
    findings.push([file, 'personal site or account identifier']);
  for (const match of content.matchAll(
    /https?:\/\/[^\s"'<>]+[?&](?:token|access_token|signature|x-amz-signature|x-goog-signature)=[^\s"'<>]+/gi,
  )) {
    if (!/(^|\.)example\.(com|org|net)$/.test(new URL(match[0]).hostname))
      findings.push([file, 'signed or authenticated URL']);
  }
  for (const value of privateValues)
    if (value.length > 1 && content.includes(value)) {
      findings.push([file, 'local configuration value']);
      break;
    }
}
if (findings.length) {
  for (const [file, reason] of findings) console.error(`${file}: ${reason}`);
  process.exitCode = 1;
} else
  console.log(
    `Public tree check passed (${files.length} staged/tracked files). Review images and history separately.`,
  );
