import DOMPurify from 'dompurify';
import { defineAsyncComponent, shallowRef, Suspense } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender, writeRef } from '../render-effects';
import { SourceText } from '../SourceText';
import { highlightedCode } from '../highlighted-code';
import { useAppearance } from '../theme/use-appearance';
import { ImagePreview } from '../ImagePreview';
import type { LocalAssetResolver, SiblingAttachment } from '../AttachmentAccess';
import type { NotebookCell, ParsedNotebook } from './notebook';

const RichMessage = defineAsyncComponent(() => import('../RichMessage'));

const NotebookCodeCell = tsxComponent(function NotebookCodeCell(_props: {
  cell: NotebookCell;
  language: string;
  onZoomImage: (img: { src: string; label: string }) => void;
}) {
  const appearance = useAppearance();
  const htmlState = shallowRef('');
  const setHtml = writeRef(htmlState);
  const watchCode = watchRender();

  return ({ cell, language, onZoomImage }) => {
    watchCode(() => {
      setHtml('');
      if (!cell.source.trim() || cell.source.length > 24 * 1024) return;
      let disposed = false;
      void highlightedCode(cell.source, language)
        .then((res) => {
          if (res && !disposed) setHtml(res);
        })
        .catch(() => {});
      return () => {
        disposed = true;
      };
    }, [cell.source, language]);

    return (
      <section class="fp-nb-cell fp-nb-code">
        <div class="fp-nb-gutter">
          In [{cell.executionCount ?? ' '}]
        </div>
        <div class="fp-nb-main">
          <div class="fp-nb-source">
            <SourceText
              text={cell.source}
              highlighted={htmlState.value || undefined}
              wrap
              lineNumbers={appearance.value.settings.lineNumbers}
            />
          </div>
          {cell.outputs.length > 0 && (
            <div class="fp-nb-outputs">
              {cell.outputs.map((out, i) => {
                if (out.kind === 'image' && out.dataUrl) {
                  return (
                    <button
                      key={i}
                      type="button"
                      class="fp-nb-image-btn"
                      onClick={() => onZoomImage({ src: out.dataUrl!, label: `Cell ${cell.index + 1} 输出图表` })}
                    >
                      <img src={out.dataUrl} alt={`输出图表 ${i + 1}`} />
                    </button>
                  );
                }
                if (out.kind === 'html' && out.html) {
                  const clean = DOMPurify.sanitize(out.html, {
                    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
                    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
                  });
                  return <div key={i} class="fp-nb-html" innerHTML={clean} />;
                }
                if (out.kind === 'error') {
                  return (
                    <pre key={i} class="fp-nb-error">
                      {out.text}
                    </pre>
                  );
                }
                return (
                  <pre key={i} class="fp-nb-text">
                    {out.text}
                  </pre>
                );
              })}
            </div>
          )}
        </div>
      </section>
    );
  };
});

export const NotebookPreview = tsxComponent(function NotebookPreview(_props: {
  notebook: ParsedNotebook;
  threadId: string;
  documentPath?: string;
  siblingFiles?: ReadonlyArray<SiblingAttachment>;
  resolveLocalAsset?: LocalAssetResolver;
}) {
  const zoomState = shallowRef<{ src: string; label: string } | null>(null);
  const setZoom = writeRef(zoomState);

  return ({ notebook, threadId, documentPath, siblingFiles, resolveLocalAsset }) => (
    <div class="fp-notebook">
      <div class="fp-subbar">
        <span class="fp-subbar-meta">
          内核：{notebook.kernelName} · {notebook.cells.length} 个单元格
          {notebook.truncated ? '（已截断前 200 个）' : ''}
        </span>
      </div>
      <div class="fp-nb-cells">
        {notebook.cells.map((cell) =>
          cell.cellType === 'markdown' ? (
            <section class="fp-nb-cell fp-nb-md" key={cell.index}>
              <Suspense>
                {{
                  default: () => (
                    <RichMessage
                      text={cell.source}
                      threadId={threadId}
                      documentPath={documentPath}
                      siblingFiles={siblingFiles}
                      resolveLocalAsset={resolveLocalAsset}
                    />
                  ),
                  fallback: () => <pre>{cell.source}</pre>,
                }}
              </Suspense>
            </section>
          ) : cell.cellType === 'code' ? (
            <NotebookCodeCell
              key={cell.index}
              cell={cell}
              language={notebook.language}
              onZoomImage={setZoom}
            />
          ) : (
            <section class="fp-nb-cell fp-nb-raw" key={cell.index}>
              <pre>{cell.source}</pre>
            </section>
          ),
        )}
      </div>
      {zoomState.value && (
        <ImagePreview
          src={zoomState.value.src}
          label={zoomState.value.label}
          error=""
          reload={0}
          onClose={() => setZoom(null)}
          onError={() => {}}
          onRetry={() => {}}
        />
      )}
    </div>
  );
});
