export interface CloudRelease {
  schema: 'fable-cloud-release-v1';
  releaseId: string;
  source: {
    commit: string;
    tree: string;
    business: Record<string, string>;
    frontend: string;
    lockfileSha256: string;
  };
}

// Replaced by the release build. Runtime environment variables cannot change this receipt.
declare const __POCKET_CLOUD_RELEASE__: CloudRelease | null;

export function cloudRelease(): CloudRelease | null {
  return typeof __POCKET_CLOUD_RELEASE__ === 'undefined' ? null : __POCKET_CLOUD_RELEASE__;
}
