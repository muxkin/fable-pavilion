import { defineAsyncComponent, shallowRef, Suspense } from 'vue';
import { tsxComponent } from './tsx-component';
import { writeRef, watchRender } from './render-effects';

import { attachmentInfo } from '../shared/attachments';
import type {
  AttachmentResource,
  LocalAssetResolver,
  SiblingAttachment,
} from './AttachmentAccess';
import { attachmentPreviewContent, type AttachmentPreviewContent } from './attachment-preview';
import { downloadFile } from './file-client';
import { Icon } from './Icon';
import { SourceText } from './SourceText';
import { useAppearance } from './theme/use-appearance';
import { highlightedCode } from './highlighted-code';
import { ImagePreview } from './ImagePreview';
import { Dialog } from './shell/Dialog';
import type { NestedPreviewRequest } from './preview/ArchivePreview';
import './file-preview.css';

const RichMessage = defineAsyncComponent(() => import('./RichMessage'));
const PdfPreview = defineAsyncComponent(() =>
  import('./preview/PdfPreview').then((m) => m.PdfPreview),
);
const DocxPreview = defineAsyncComponent(() =>
  import('./preview/DocxPreview').then((m) => m.DocxPreview),
);
const SpreadsheetPreview = defineAsyncComponent(() =>
  import('./preview/SpreadsheetPreview').then((m) => m.SpreadsheetPreview),
);
const PresentationPreview = defineAsyncComponent(() =>
  import('./preview/PresentationPreview').then((m) => m.PresentationPreview),
);
const NotebookPreview = defineAsyncComponent(() =>
  import('./preview/NotebookPreview').then((m) => m.NotebookPreview),
);
const ArchivePreview = defineAsyncComponent(() =>
  import('./preview/ArchivePreview').then((m) => m.ArchivePreview),
);
const StructuredTreeView = defineAsyncComponent(() =>
  import('./preview/StructuredTreeView').then((m) => m.StructuredTreeView),
);
const SvgCanvasPreview = defineAsyncComponent(() =>
  import('./preview/HtmlSvgPreview').then((m) => m.SvgCanvasPreview),
);
const HtmlSandboxPreview = defineAsyncComponent(() =>
  import('./preview/HtmlSvgPreview').then((m) => m.HtmlSandboxPreview),
);

const HIGHLIGHT_LIMIT = 48 * 1024;

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export const AttachmentPreview = tsxComponent(function AttachmentPreviewSetup(_props: {
  path: string;
  name: string;
  load: (signal: AbortSignal) => Promise<AttachmentResource>;
  trigger: HTMLElement | null;
  onClose: () => void;
  onCopyImage?: () => Promise<void>;
  threadId?: string;
  siblingFiles?: ReadonlyArray<SiblingAttachment>;
  resolveLocalAsset?: LocalAssetResolver;
}) {
  const appearance = useAppearance();
  const fileState = shallowRef<AttachmentResource>();
  const setFile = writeRef(fileState);
  const contentState = shallowRef<AttachmentPreviewContent>();
  const setContent = writeRef(contentState);
  const highlightState = shallowRef<{ text: string; language: string; html: string }>();
  const setHighlight = writeRef(highlightState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const retryState = shallowRef(0);
  const setRetry = writeRef(retryState);
  const altViewState = shallowRef(false);
  const setAltView = writeRef(altViewState);
  const wrapState = shallowRef(true);
  const setWrap = writeRef(wrapState);
  const copyStatusState = shallowRef('');
  const setCopyStatus = writeRef(copyStatusState);
  const nestedState = shallowRef<NestedPreviewRequest | null>(null);
  const setNested = writeRef(nestedState);
  const watchFile = watchRender();
  const watchHighlight = watchRender();

  return ({
    path,
    name,
    load,
    trigger,
    onClose,
    onCopyImage,
    threadId = '',
    siblingFiles,
    resolveLocalAsset,
  }) => {
    const file = fileState.value;
    const content = contentState.value;
    const error = errorState.value;
    const retry = retryState.value;
    const altView = altViewState.value;
    const wrap = wrapState.value;
    const copyStatus = copyStatusState.value;

    watchFile(() => {
      const controller = new AbortController();
      setAltView(false);
      void (async () => {
        try {
          const resource = await load(controller.signal);
          if (controller.signal.aborted) return;
          setFile(resource);
          const preview = await attachmentPreviewContent(resource, path, controller.signal);
          if (controller.signal.aborted) return;
          setContent(preview);
          setError('');
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '文件读取失败');
        }
      })();
      return () => {
        controller.abort();
        if (nestedState.value) {
          nestedState.value.cleanup();
          setNested(null);
        }
      };
    }, [load, path, retry]);

    function reload() {
      setError('');
      setRetry((value) => value + 1);
    }

    function closeNested() {
      nestedState.value?.cleanup();
      setNested(null);
    }

    const rawText =
      content?.kind === 'text'
        ? content.text
        : content?.kind === 'markdown' ||
            content?.kind === 'svg' ||
            content?.kind === 'html' ||
            content?.kind === 'notebook'
          ? content.text
          : undefined;
    const rawTruncated =
      content?.kind === 'text' ||
      content?.kind === 'markdown' ||
      content?.kind === 'svg' ||
      content?.kind === 'html' ||
      content?.kind === 'notebook'
        ? content.truncated
        : false;
    const sourceLanguage =
      content?.kind === 'text'
        ? content.syntax?.language
        : content?.kind === 'markdown'
          ? 'markdown'
          : content?.kind === 'svg'
            ? 'xml'
            : content?.kind === 'html'
              ? 'html'
              : content?.kind === 'notebook'
                ? 'json'
                : undefined;

    const showingSource =
      content?.kind === 'text'
        ? (!content.table?.rows.length && !content.structured) || altView
        : content?.kind === 'markdown' || content?.kind === 'svg' || content?.kind === 'notebook'
          ? altView
          : content?.kind === 'html'
            ? !altView
            : false;

    const highlight = highlightState.value;
    watchHighlight(() => {
      setHighlight(undefined);
      if (
        !showingSource ||
        !rawText ||
        !sourceLanguage ||
        rawTruncated ||
        rawText.length > HIGHLIGHT_LIMIT
      ) {
        return;
      }
      let disposed = false;
      void highlightedCode(rawText, sourceLanguage)
        .then((html) => {
          if (html && !disposed) setHighlight({ text: rawText, language: sourceLanguage, html });
        })
        .catch(() => {});
      return () => {
        disposed = true;
      };
    }, [showingSource, rawText, sourceLanguage, rawTruncated]);

    const title = file?.name || name;
    const info = attachmentInfo(path, title);
    const download = file ? () => downloadFile({ ...file, url: file.downloadUrl ?? file.url }) : undefined;

    if (file && content?.kind === 'image') {
      return (
        <ImagePreview
          src={file.url}
          label={title}
          error={error}
          reload={retry}
          returnFocus={trigger}
          onClose={onClose}
          onCopy={onCopyImage}
          onDownload={download}
          onError={() => setError('图片加载失败，请重试')}
          onRetry={reload}
        />
      );
    }

    const toggleLabels: [string, string] | undefined =
      content?.kind === 'markdown'
        ? ['渲染视图', '查看源码']
        : content?.kind === 'svg'
          ? ['画布预览', '查看源码']
          : content?.kind === 'html'
            ? ['沙箱预览', '查看源码']
            : content?.kind === 'notebook'
              ? ['笔记本视图', '原始 JSON']
              : content?.kind === 'text' && content.table?.rows.length
                ? ['表格视图', '查看源码']
                : content?.kind === 'text' && content.structured
                  ? ['结构树', '查看源码']
                  : undefined;

    const kindLabel =
      content?.kind === 'markdown'
        ? 'Markdown 文档'
        : content?.kind === 'svg'
          ? 'SVG 矢量图'
          : content?.kind === 'html'
            ? 'HTML 文档'
            : content?.kind === 'notebook'
              ? 'Jupyter 笔记本'
              : content?.kind === 'pdf'
                ? 'PDF 文档'
                : content?.kind === 'docx'
                  ? 'Word 文档'
                  : content?.kind === 'xlsx'
                    ? 'Excel 工作簿'
                    : content?.kind === 'pptx'
                      ? 'PPT 演示文稿'
                      : content?.kind === 'archive'
                        ? '压缩包'
                        : content?.kind === 'text'
                          ? content.table
                            ? info.kind
                            : content.syntax
                              ? `${content.syntax.label} 源码`
                              : '文本文件'
                          : info.kind;

    const highlightHtml =
      highlight && highlight.text === rawText && highlight.language === sourceLanguage
        ? highlight.html
        : undefined;

    const suspenseFallback = (
      <p class="file-preview-state" role="status">
        正在加载预览组件…
      </p>
    );

    return (
      <>
        <Dialog title={title} className="file-preview" onClose={onClose} returnFocus={trigger}>
          {() => (
            <>
              <div class="file-preview-toolbar">
                <span class="file-preview-type">
                  {kindLabel}
                  {file && ` · ${fileSize(file.size)}`}
                </span>
                <div class="file-preview-actions">
                  {toggleLabels && (
                    <button type="button" onClick={() => setAltView(!altView)}>
                      {showingSource ? toggleLabels[0] : toggleLabels[1]}
                    </button>
                  )}
                  {!!rawText && showingSource && (
                    <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                      自动换行
                    </button>
                  )}
                  {!!rawText && (showingSource || content?.kind === 'markdown') && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(rawText);
                          setCopyStatus('已复制');
                        } catch {
                          setCopyStatus('复制失败，可选中文字手动复制');
                        }
                      }}
                    >
                      <Icon name="copy" size={16} />
                      {rawTruncated ? '复制预览' : '复制文本'}
                    </button>
                  )}
                  {download && (
                    <button type="button" onClick={download}>
                      <Icon name="download" size={16} />
                      下载
                    </button>
                  )}
                </div>
              </div>
              {copyStatus && (
                <p class="file-preview-note" role="status">
                  {copyStatus}
                </p>
              )}
              {rawTruncated && (
                <p class="file-preview-note">仅显示前部内容，可下载完整文件查看。</p>
              )}
              <div
                class="file-preview-content"
                tabindex={showingSource && rawText ? 0 : undefined}
                role={showingSource && rawText ? 'region' : undefined}
                aria-label={showingSource && rawText ? '文件内容' : undefined}
              >
                {error ? (
                  <div class="file-preview-state" role="alert">
                    <p>{error}</p>
                    <button type="button" onClick={reload}>
                      重试
                    </button>
                  </div>
                ) : !file || !content ? (
                  <p class="file-preview-state" role="status">
                    正在读取文件…
                  </p>
                ) : showingSource && rawText !== undefined ? (
                  rawText ? (
                    <SourceText
                      text={rawText}
                      highlighted={highlightHtml}
                      wrap={wrap}
                      lineNumbers={appearance.value.settings.lineNumbers}
                    />
                  ) : (
                    <p class="file-preview-state">文件为空。</p>
                  )
                ) : content.kind === 'markdown' ? (
                  <div class="fp-markdown-doc">
                    <Suspense>
                      {{
                        default: () => (
                          <RichMessage
                            text={content.text}
                            threadId={threadId}
                            documentPath={path}
                            siblingFiles={siblingFiles}
                            resolveLocalAsset={resolveLocalAsset}
                          />
                        ),
                        fallback: () => suspenseFallback,
                      }}
                    </Suspense>
                  </div>
                ) : content.kind === 'svg' ? (
                  <Suspense>
                    {{
                      default: () => <SvgCanvasPreview text={content.text} label={title} />,
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'html' ? (
                  <Suspense>
                    {{
                      default: () => <HtmlSandboxPreview html={content.text} title={title} />,
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'notebook' ? (
                  <Suspense>
                    {{
                      default: () => (
                        <NotebookPreview
                          notebook={content.notebook}
                          threadId={threadId}
                          documentPath={path}
                          siblingFiles={siblingFiles}
                          resolveLocalAsset={resolveLocalAsset}
                        />
                      ),
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'text' && content.table?.rows.length ? (
                  <Suspense>
                    {{
                      default: () => (
                        <SpreadsheetPreview
                          sheets={[
                            {
                              name: title,
                              rows: content.table!.rows,
                              clipped: content.table!.clipped,
                            },
                          ]}
                        />
                      ),
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'text' && content.structured ? (
                  <Suspense>
                    {{
                      default: () => <StructuredTreeView value={content.structured!.value} />,
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'xlsx' ? (
                  <Suspense>
                    {{
                      default: () => (
                        <SpreadsheetPreview
                          sheets={content.workbook.sheets}
                          clippedSheets={content.workbook.clippedSheets}
                        />
                      ),
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'pptx' ? (
                  <Suspense>
                    {{
                      default: () => <PresentationPreview presentation={content.presentation} />,
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'pdf' ? (
                  <Suspense>
                    {{
                      default: () => <PdfPreview bytes={content.bytes} url={file.url} />,
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'docx' ? (
                  <Suspense>
                    {{
                      default: () => <DocxPreview buffer={content.buffer} />,
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'archive' ? (
                  <Suspense>
                    {{
                      default: () => (
                        <ArchivePreview
                          archive={content.archive}
                          onOpenEntry={(req) => {
                            nestedState.value?.cleanup();
                            setNested(req);
                          }}
                        />
                      ),
                      fallback: () => suspenseFallback,
                    }}
                  </Suspense>
                ) : content.kind === 'video' ? (
                  <video
                    src={file.url}
                    controls
                    playsinline
                    preload="metadata"
                    onError={() => setError('视频无法播放，请重试')}
                  />
                ) : content.kind === 'audio' ? (
                  <audio
                    src={file.url}
                    controls
                    preload="metadata"
                    onError={() => setError('音频无法播放，请重试')}
                  />
                ) : content.kind === 'unsupported' ? (
                  <p class="file-preview-state">{content.reason}</p>
                ) : null}
              </div>
            </>
          )}
        </Dialog>
        {nestedState.value && (
          <AttachmentPreview
            key={`nested:${nestedState.value.path}`}
            path={nestedState.value.path}
            name={nestedState.value.name}
            threadId={threadId}
            load={nestedState.value.load}
            resolveLocalAsset={nestedState.value.resolveLocalAsset}
            trigger={null}
            onClose={closeNested}
          />
        )}
      </>
    );
  };
});
