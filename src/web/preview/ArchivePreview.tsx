import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { writeRef } from '../render-effects';
import { Icon } from '../Icon';
import { downloadFile } from '../file-client';
import { attachmentInfo } from '../../shared/attachments';
import { attachmentMime } from '../../shared/attachment-mime';
import type { AttachmentResource, LocalAssetResolver } from '../AttachmentAccess';
import { resolveArchiveRelativePath, type ArchiveEntry, type ParsedArchive } from './archive';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export interface NestedPreviewRequest {
  path: string;
  name: string;
  load: (signal: AbortSignal) => Promise<AttachmentResource>;
  resolveLocalAsset: LocalAssetResolver;
  cleanup: () => void;
}

export const ArchivePreview = tsxComponent(function ArchivePreview(_props: {
  archive: ParsedArchive;
  onOpenEntry: (request: NestedPreviewRequest) => void;
}) {
  const filterState = shallowRef('');
  const setFilter = writeRef(filterState);

  return ({ archive, onOpenEntry }) => {
    const query = filterState.value.trim().toLowerCase();
    const filesOnly = archive.entries.filter((e) => !e.directory);
    const visible = query
      ? filesOnly.filter((e) => e.path.toLowerCase().includes(query))
      : filesOnly;

    function createEntryResource(entryPath: string): { resource: AttachmentResource; url: string } | null {
      const data = archive.readEntry(entryPath);
      if (!data) return null;
      const name = entryPath.split('/').at(-1) || entryPath;
      const mime = attachmentMime(name, data.subarray(0, 4096));
      const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: mime });
      const url = URL.createObjectURL(blob);
      return {
        url,
        resource: {
          url,
          blob,
          name,
          mime,
          size: data.byteLength,
          expiresAt: 0,
        },
      };
    }

    function openEntry(entry: ArchiveEntry) {
      const createdUrls: string[] = [];
      let cachedMain: AttachmentResource | null = null;
      const load = async (_signal: AbortSignal): Promise<AttachmentResource> => {
        if (cachedMain) return cachedMain;
        const created = createEntryResource(entry.path);
        if (!created) throw new Error('此压缩包条目体积过大或无法读取，请下载完整压缩包查看。');
        createdUrls.push(created.url);
        cachedMain = created.resource;
        return cachedMain;
      };
      const assetCache = new Map<string, AttachmentResource | null>();
      const resolveLocalAsset: LocalAssetResolver = async (rawSrc) => {
        const target = resolveArchiveRelativePath(entry.path, rawSrc);
        if (assetCache.has(target)) return assetCache.get(target) ?? null;
        const created = createEntryResource(target);
        if (!created) {
          assetCache.set(target, null);
          return null;
        }
        createdUrls.push(created.url);
        assetCache.set(target, created.resource);
        return created.resource;
      };
      onOpenEntry({
        path: `/${entry.path}`,
        name: entry.name,
        load,
        resolveLocalAsset,
        cleanup: () => {
          for (const url of createdUrls) URL.revokeObjectURL(url);
        },
      });
    }

    function downloadEntry(entry: ArchiveEntry) {
      const created = createEntryResource(entry.path);
      if (!created) return;
      downloadFile({ url: created.url, name: entry.name });
      setTimeout(() => URL.revokeObjectURL(created.url), 10000);
    }

    return (
      <div class="fp-archive">
        <div class="fp-subbar">
          <input
            type="search"
            class="fp-filter-input"
            placeholder="搜索压缩包内文件…"
            value={filterState.value}
            onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          />
          <span class="fp-subbar-meta">
            {archive.format.toUpperCase()} · {filesOnly.length} 个文件 · 解压约 {formatBytes(archive.totalSize)}
          </span>
        </div>
        {archive.truncated && (
          <p class="fp-inline-note">压缩包条目或解压体积较大，仅列出部分内容，可下载完整文件。</p>
        )}
        <div class="fp-archive-list" role="list">
          {visible.length === 0 ? (
            <p class="file-preview-state">没有匹配的包内文件。</p>
          ) : (
            visible.map((entry) => {
              const info = attachmentInfo(entry.path, entry.name);
              const readable = archive.readEntry(entry.path) !== null;
              return (
                <div class="fp-archive-row" role="listitem" key={entry.path}>
                  <button
                    type="button"
                    class="fp-archive-main"
                    disabled={!readable}
                    title={readable ? `预览 ${entry.path}` : '条目超过单文件预览上限'}
                    onClick={() => openEntry(entry)}
                  >
                    <Icon name={info.media === 'image' ? 'image' : 'document'} size={15} />
                    <span class="fp-archive-path">{entry.path}</span>
                    <span class="fp-archive-size">{formatBytes(entry.size)}</span>
                  </button>
                  {readable && (
                    <button
                      type="button"
                      class="fp-archive-dl"
                      title={`下载 ${entry.name}`}
                      aria-label={`下载 ${entry.name}`}
                      onClick={() => downloadEntry(entry)}
                    >
                      <Icon name="download" size={14} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };
});
