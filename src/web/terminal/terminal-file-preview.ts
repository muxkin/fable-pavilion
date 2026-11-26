import { attachmentMime } from '../../shared/attachment-mime';
import { attachmentName, resolveMarkdownAssetPath } from '../../shared/attachments';
import { TERMINAL_BACKEND_ID, type TerminalFsEntry } from '../../shared/plugins';
import type { AttachmentResource, LocalAssetResolver } from '../AttachmentAccess';
import { deviceSession } from '../device-session';

export interface TerminalPreviewTarget {
  path: string;
  name: string;
  load: (signal: AbortSignal) => Promise<AttachmentResource>;
  resolveLocalAsset: LocalAssetResolver;
  cleanup: () => void;
}

export function createTerminalPreviewTarget(
  sessionId: string,
  entry: TerminalFsEntry,
): TerminalPreviewTarget {
  const createdUrls: string[] = [];
  const cache = new Map<string, Promise<AttachmentResource>>();

  const fetchPath = (targetPath: string, fallbackName: string): Promise<AttachmentResource> => {
    const existing = cache.get(targetPath);
    if (existing) return existing;
    const promise = (async () => {
      const { value, bytes } = await deviceSession.rpcBinary<{ name: string; size: number }>(
        `/api/terminal/sessions/${encodeURIComponent(sessionId)}/download`,
        'POST',
        { path: targetPath },
        undefined,
        TERMINAL_BACKEND_ID,
      );
      if (!bytes) throw new Error('未读取到文件内容');
      const name = value.name || fallbackName;
      const mime = attachmentMime(name, bytes.subarray(0, 4096));
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
      const url = URL.createObjectURL(blob);
      createdUrls.push(url);
      return {
        url,
        blob,
        name,
        mime,
        size: bytes.byteLength,
        expiresAt: 0,
      };
    })();
    cache.set(targetPath, promise);
    promise.catch(() => cache.delete(targetPath));
    return promise;
  };

  return {
    path: entry.path,
    name: entry.name,
    load: async () => fetchPath(entry.path, entry.name),
    resolveLocalAsset: async (rawSrc) => {
      const resolved = resolveMarkdownAssetPath(rawSrc, entry.path);
      try {
        return await fetchPath(resolved, attachmentName(resolved));
      } catch {
        return null;
      }
    },
    cleanup: () => {
      for (const url of createdUrls) URL.revokeObjectURL(url);
      createdUrls.length = 0;
      cache.clear();
    },
  };
}
