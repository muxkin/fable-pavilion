import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { writeRef, watchRender } from './render-effects';
import {
  useAttachmentAccess,
  type LocalAssetResolver,
  type SiblingAttachment,
} from './AttachmentAccess';
import { remoteFetch } from './device-session';
import { ImagePreview } from './ImagePreview';
import { AttachmentActions } from './AttachmentActions';
import { AttachmentIdentity } from './AttachmentIdentity';
import {
  attachmentInfo,
  isBareRelativeAssetPath,
  isExternalUrl,
  localReference,
  attachmentName,
} from '../shared/attachments';
import { mediaContent, downloadFile } from './file-client';
import { useVisible } from './useVisible';
import { copyImage, imageBlob } from './image-clipboard';

function matchSiblingAttachment(
  src: string,
  siblings?: ReadonlyArray<SiblingAttachment>,
): SiblingAttachment | undefined {
  if (!siblings?.length) return undefined;
  const cleaned = src.split(/[?#]/)[0];
  let decoded = cleaned;
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    /* ignore */
  }
  const targetName = attachmentName(decoded).toLowerCase();
  if (!targetName) return undefined;
  return siblings.find(
    (item) =>
      item.name.toLowerCase() === targetName &&
      (!item.mime || /^(image|audio|video)\//.test(item.mime)),
  );
}

export const Media = tsxComponent(function Media(_props: {
  src: string;
  label: string;
  threadId: string;
  compact?: boolean;
  onRemove?: () => void;
  mediaType?: 'image' | 'video' | 'audio';
  fromDocument?: string;
  siblingFiles?: ReadonlyArray<SiblingAttachment>;
  resolveLocalAsset?: LocalAssetResolver;
}) {
  const attachmentAccess = useAttachmentAccess();
  const { ref, visible: intersectionVisible } = useVisible();
  const urlState = shallowRef('');
  const setUrl = writeRef(urlState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const refreshState = shallowRef(0);
  const setRefresh = writeRef(refreshState);
  const previewState = shallowRef(false);
  const setPreview = writeRef(previewState);
  const originalState = shallowRef('');
  const setOriginal = writeRef(originalState);
  const unavailableNoteState = shallowRef('');
  const setUnavailableNote = writeRef(unavailableNoteState);
  const expiresAt = { current: 0 };
  const refreshing = { current: false };
  const recovery: { current: { time: number; playing: boolean } | null } = { current: null };
  const watchUrl = watchRender();
  return ({
    src,
    label,
    threadId,
    compact = false,
    onRemove,
    mediaType,
    fromDocument,
    siblingFiles,
    resolveLocalAsset,
  }) => {
    const access = attachmentAccess.value;
    const visible = intersectionVisible.value;
    const isDocumentLocalRef =
      !!fromDocument && (localReference(src) || isBareRelativeAssetPath(src));
    const matchedSibling =
      access && isDocumentLocalRef ? matchSiblingAttachment(src, siblingFiles) : undefined;
    const accessTarget = matchedSibling ? matchedSibling.url : src;
    // Start external media only after visibility initialization, too. Otherwise a
    // fast failed load can be cleared by the first visibility effect.
    const cached =
      access && (!isDocumentLocalRef || matchedSibling)
        ? access.peek?.(threadId, accessTarget)
        : undefined;
    const url = urlState.value || cached?.url || '';
    const error = errorState.value;
    const unavailableNote = unavailableNoteState.value;
    const refresh = refreshState.value;
    const preview = previewState.value;
    const original = originalState.value;

    function renew(element?: HTMLMediaElement) {
      if (refreshing.current) return;
      refreshing.current = true;
      recovery.current = element ? { time: element.currentTime, playing: !element.paused } : null;
      setError('');
      setRefresh((value) => value + 1);
    }
    function checkExpiry(element: HTMLMediaElement) {
      if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew(element);
    }
    function failed(element?: HTMLMediaElement) {
      if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew(element);
      else setError('附件加载失败，可重新获取访问链接');
    }
    function restore(element: HTMLMediaElement) {
      const previous = recovery.current;
      recovery.current = null;
      if (!previous) return;
      if (Number.isFinite(previous.time)) element.currentTime = previous.time;
      if (previous.playing) void element.play().catch(() => {});
    }
    watchUrl(() => {
      if (!visible) return;
      setUnavailableNote('');
      if (resolveLocalAsset && !isExternalUrl(src)) {
        const controller = new AbortController();
        void resolveLocalAsset(src, controller.signal)
          .then((file) => {
            if (controller.signal.aborted) return;
            if (!file) {
              setUnavailableNote(`本地图片不可用：${attachmentName(src)}`);
              setError('');
              return;
            }
            expiresAt.current = file.expiresAt;
            setUrl(file.url);
            setError('');
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '图片加载失败');
          })
          .finally(() => {
            refreshing.current = false;
          });
        return () => controller.abort();
      }
      if (access) {
        if (fromDocument && isExternalUrl(src)) {
          expiresAt.current = 0;
          setUrl(src);
          setError('');
          refreshing.current = false;
          return;
        }
        if (isDocumentLocalRef && !matchedSibling) {
          expiresAt.current = 0;
          setUrl('');
          setError('');
          setUnavailableNote(`本地图片未随文档上传：${src}`);
          refreshing.current = false;
          return;
        }
        const controller = new AbortController();
        void access
          .load(threadId, accessTarget, controller.signal)
          .then((file) => {
            if (controller.signal.aborted) return;
            if (!/^(image|audio|video)\//.test(file.mime)) throw Error('此附件不支持媒体预览');
            expiresAt.current = file.expiresAt;
            setUrl(file.url);
            setError('');
          })
          .catch((error) => {
            if (!controller.signal.aborted) setError(error.message);
          })
          .finally(() => {
            refreshing.current = false;
          });
        return () => controller.abort();
      }
      if (!localReference(src)) {
        expiresAt.current = 0;
        setUrl(src);
        setError('');
        refreshing.current = false;
        return;
      }
      const controller = new AbortController();
      void remoteFetch(`/api/threads/${encodeURIComponent(threadId)}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fromDocument ? { path: src, fromDocument } : { path: src }),
        signal: controller.signal,
      })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error ?? '附件不可用');
          expiresAt.current = body.expiresAt;
          setUrl(body.url);
          setError('');
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          refreshing.current = false;
        });
      return () => controller.abort();
    }, [src, threadId, visible, refresh, access, fromDocument, matchedSibling?.url, resolveLocalAsset]);
    async function download() {
      if (resolveLocalAsset && !isExternalUrl(src)) {
        const file = await resolveLocalAsset(src);
        if (file) return downloadFile({ ...file, url: file.downloadUrl ?? file.url });
        throw Error('本地图片不可用');
      }
      if (access && (!isDocumentLocalRef || matchedSibling)) {
        const file = await access.load(threadId, accessTarget, undefined, true);
        return downloadFile({ ...file, url: file.downloadUrl ?? file.url });
      }
      if (localReference(src)) return downloadFile(await mediaContent(threadId, src, undefined, fromDocument));
      const response = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw Error('图片下载失败，请重试');
      const temporary = URL.createObjectURL(await response.blob());
      downloadFile({ url: temporary, name: attachmentName(src) });
      setTimeout(() => URL.revokeObjectURL(temporary), 60000);
    }
    const info = attachmentInfo(src.split(/[?#]/)[0]);
    const media = mediaType ?? info.media;
    const name = label || info.name;
    const copyOriginal = () =>
      copyImage(async () => {
        const file =
          resolveLocalAsset && !isExternalUrl(src)
            ? await resolveLocalAsset(src)
            : access && (!isDocumentLocalRef || matchedSibling)
              ? await access.load(threadId, accessTarget, undefined, true)
              : localReference(src)
                ? await mediaContent(threadId, src, undefined, fromDocument)
                : { url: src };
        if (!file) throw Error('图片不可用');
        return imageBlob(file.url);
      });
    if (unavailableNote) {
      return (
        <span class="file-preview-local-image-note" ref={ref} title={src}>
          <AttachmentIdentity path={src} name={label && label !== '图片' ? `${label}（${unavailableNote}）` : unavailableNote} />
        </span>
      );
    }
    return (
      <AttachmentActions
        path={src}
        name={name}
        onDownload={download}
        onCopyImage={media === 'image' ? copyOriginal : undefined}
        hideMore={media === 'image'}
        surface={compact ? 'compact' : 'media'}
        onRemove={onRemove}
      >
        {() => (
          <>
            <div class="media" ref={ref} data-media-type={media}>
              {url ? (
                media === 'video' ? (
                  <video
                    key={`${url}:${localReference(src) ? '' : refresh}`}
                    controls
                    preload="metadata"
                    src={url}
                    aria-label={label}
                    onPlay={(e) => checkExpiry(e.currentTarget as HTMLVideoElement)}
                    onSeeking={(e) => checkExpiry(e.currentTarget as HTMLVideoElement)}
                    onError={(e) => failed(e.currentTarget as HTMLVideoElement)}
                    onLoadedmetadata={(e) => restore(e.currentTarget as HTMLVideoElement)}
                  />
                ) : media === 'audio' ? (
                  <audio
                    key={`${url}:${localReference(src) ? '' : refresh}`}
                    controls
                    preload="none"
                    src={url}
                    aria-label={label}
                    onPlay={(e) => checkExpiry(e.currentTarget as HTMLAudioElement)}
                    onSeeking={(e) => checkExpiry(e.currentTarget as HTMLAudioElement)}
                    onError={(e) => failed(e.currentTarget as HTMLAudioElement)}
                    onLoadedmetadata={(e) => restore(e.currentTarget as HTMLAudioElement)}
                  />
                ) : (
                  <button
                    type="button"
                    class={compact ? 'file-card-link image-thumbnail compact-image' : 'image-thumbnail'}
                    aria-label={`放大预览：${label || '图片'}`}
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew();
                      setPreview(true);
                      if (access && (!isDocumentLocalRef || matchedSibling))
                        void access
                          .load(threadId, accessTarget, undefined, true)
                          .then((file) => setOriginal(file.url))
                          .catch(() => setError('原图加载失败，可重试'));
                    }}
                  >
                    {compact ? (
                      <AttachmentIdentity
                        path={src}
                        name={name}
                        leading={
                          <img
                            key={`${url}:${localReference(src) ? '' : refresh}`}
                            loading={cached ? 'eager' : 'lazy'}
                            decoding="async"
                            src={url}
                            alt=""
                            referrerpolicy="no-referrer"
                            onError={() => failed()}
                          />
                        }
                      />
                    ) : (
                      <img
                        key={`${url}:${localReference(src) ? '' : refresh}`}
                        loading={cached ? 'eager' : 'lazy'}
                        decoding="async"
                        src={url}
                        alt={label}
                        referrerpolicy="no-referrer"
                        onError={() => failed()}
                      />
                    )}
                  </button>
                )
              ) : compact || error ? (
                <span class="file-card-link" aria-busy={!error}>
                  <AttachmentIdentity path={src} name={name} />
                </span>
              ) : (
                <span class="attachment-media-loading" role="status">
                  正在加载附件…
                </span>
              )}
              {!compact && url && label && media !== 'audio' && (
                <span class="attachment-caption" title={label}>
                  {label}
                </span>
              )}
              {error && (
                <div role="alert">
                  <small>{error}</small>
                  {!error.startsWith('原附件文件已') && (
                    <button type="button" class="secondary" onClick={() => renew()}>
                      重新加载附件
                    </button>
                  )}
                </div>
              )}
              {preview && url && (
                <ImagePreview
                  key={src}
                  src={original || url}
                  label={label}
                  error={error}
                  reload={refresh}
                  onClose={() => setPreview(false)}
                  onError={() => failed()}
                  onRetry={() => renew()}
                  onCopy={copyOriginal}
                  onDownload={download}
                />
              )}
            </div>
          </>
        )}
      </AttachmentActions>
    );
  };
});
