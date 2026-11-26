import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender, writeRef } from '../render-effects';

type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | undefined;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const ZOOM_STEPS = [0.6, 0.75, 1, 1.25, 1.5, 2, 2.5];

export const PdfPreview = tsxComponent(function PdfPreview(_props: {
  bytes?: Uint8Array;
  url: string;
}) {
  const docState = shallowRef<PdfDocument | null>(null);
  const setDoc = writeRef(docState);
  const pageCountState = shallowRef(0);
  const setPageCount = writeRef(pageCountState);
  const pageState = shallowRef(1);
  const setPage = writeRef(pageState);
  const zoomState = shallowRef(1);
  const setZoom = writeRef(zoomState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const renderingState = shallowRef(false);
  const setRendering = writeRef(renderingState);
  const canvasRef = shallowRef<HTMLCanvasElement | null>(null);
  const watchDoc = watchRender();
  const watchPage = watchRender();

  return ({ bytes, url }) => {
    watchDoc(() => {
      setDoc(null);
      setPageCount(0);
      setPage(1);
      setError('');
      if (!bytes) {
        setLoading(false);
        return;
      }
      setLoading(true);
      let cancelled = false;
      let loadingTask: import('pdfjs-dist').PDFDocumentLoadingTask | null = null;
      void (async () => {
        try {
          const pdfjs = await loadPdfjs();
          if (cancelled) return;
          // Copy buffer because pdf.js transfers ownership of TypedArrays to its worker.
          loadingTask = pdfjs.getDocument({
            data: bytes.slice(),
            useWasm: false,
            useSystemFonts: true,
          });
          const pdf = await loadingTask.promise;
          if (cancelled) {
            void loadingTask.destroy();
            return;
          }
          setDoc(pdf);
          setPageCount(pdf.numPages);
          setLoading(false);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'PDF 解析失败');
            setLoading(false);
          }
        }
      })();
      return () => {
        cancelled = true;
        if (loadingTask) {
          void loadingTask.destroy();
          loadingTask = null;
        }
      };
    }, [bytes]);

    const doc = docState.value;
    const pageCount = pageCountState.value;
    const pageNum = pageState.value;
    const zoom = zoomState.value;

    watchPage(() => {
      const canvas = canvasRef.value;
      if (!doc || !canvas || pageNum < 1 || pageNum > doc.numPages) return;
      let cancelled = false;
      let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
      setRendering(true);
      void (async () => {
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const baseViewport = page.getViewport({ scale: 1 });
          const containerWidth = Math.max(300, (canvas.parentElement?.clientWidth ?? 760) - 32);
          const fitScale = Math.min(1.6, containerWidth / baseViewport.width);
          const cssScale = fitScale * zoom;
          const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
          const viewport = page.getViewport({ scale: cssScale * dpr });
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          renderTask = page.render({ canvas, canvasContext: ctx, viewport });
          await renderTask.promise;
        } catch (err) {
          if (!cancelled && !(err instanceof Error && err.name === 'RenderingCancelledException')) {
            setError('PDF 页面渲染失败，可尝试新标签打开或下载查看');
          }
        } finally {
          if (!cancelled) setRendering(false);
        }
      })();
      return () => {
        cancelled = true;
        renderTask?.cancel();
      };
    }, [doc, pageNum, zoom, canvasRef.value]);

    if (!bytes) {
      return (
        <div class="file-preview-state">
          <p>PDF 体积超过 48 MB，建议使用新标签或下载查看。</p>
          <a href={url} target="_blank" rel="noopener noreferrer">
            新标签打开 PDF
          </a>
        </div>
      );
    }

    const stepZoom = (delta: number) => {
      const idx = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.01);
      const current = idx === -1 ? ZOOM_STEPS.length - 1 : idx;
      const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, current + delta));
      setZoom(ZOOM_STEPS[next]);
    };

    return (
      <div class="fp-pdf">
        <div class="fp-subbar">
          <div class="fp-subbar-actions">
            <button type="button" disabled={pageNum <= 1} onClick={() => setPage(pageNum - 1)}>
              上一页
            </button>
            <label class="fp-pdf-jump">
              <input
                type="number"
                min={1}
                max={Math.max(1, pageCount)}
                value={pageNum}
                aria-label="页码"
                onChange={(e) => {
                  const next = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  if (Number.isFinite(next) && pageCount > 0) {
                    setPage(Math.max(1, Math.min(pageCount, next)));
                  }
                }}
              />
              <span>/ {pageCount || '…'}</span>
            </label>
            <button
              type="button"
              disabled={pageCount === 0 || pageNum >= pageCount}
              onClick={() => setPage(pageNum + 1)}
            >
              下一页
            </button>
          </div>
          <div class="fp-subbar-actions">
            <button type="button" disabled={zoom <= ZOOM_STEPS[0]} onClick={() => stepZoom(-1)}>
              缩小
            </button>
            <span class="fp-subbar-meta">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              onClick={() => stepZoom(1)}
            >
              放大
            </button>
            <a class="fp-link-btn" href={url} target="_blank" rel="noopener noreferrer">
              新标签打开
            </a>
          </div>
        </div>
        {errorState.value ? (
          <div class="file-preview-state" role="alert">
            <p>{errorState.value}</p>
            <a href={url} target="_blank" rel="noopener noreferrer">
              新标签打开 PDF
            </a>
          </div>
        ) : loadingState.value ? (
          <p class="file-preview-state" role="status">
            正在加载 PDF…
          </p>
        ) : (
          <div class="fp-pdf-stage">
            <canvas ref={canvasRef} class="fp-pdf-canvas" />
            {renderingState.value && (
              <span class="fp-pdf-rendering" role="status">
                渲染中…
              </span>
            )}
          </div>
        )}
      </div>
    );
  };
});
