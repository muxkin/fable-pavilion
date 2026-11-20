import type { CloudRelease } from '../../src/shared/cloud-release.js';
export function configuredRelease(cwd?: string): CloudRelease | null;
export function sourceRelease(expectedCommit: string, cwd?: string): CloudRelease;
