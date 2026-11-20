import { spawnSync } from 'node:child_process';
import { officialProducts } from './native-package-contract.mjs';

// Keep product connectors outside the default gateway build. Node orchestrates
// development builds only; each delivered executable is compiled by Cargo.
for (const args of [
  ['--bin', 'agent-space-native'],
  ['--no-default-features', '--features', 'official-plugins', ...officialProducts.flatMap((product) => ['--bin', `agent-space-adapter-${product}`])],
]) {
  const result = spawnSync('cargo', ['build', '--manifest-path', 'desktop/native/Cargo.toml', '--release', '--locked', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
