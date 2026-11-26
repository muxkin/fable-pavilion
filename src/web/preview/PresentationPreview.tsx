import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender, writeRef } from '../render-effects';
import { ImagePreview } from '../ImagePreview';
import type { ParsedPresentation } from './ooxml';

export const PresentationPreview = tsxComponent(function PresentationPreview(_props: {
  presentation: ParsedPresentation;
}) {
  const currentState = shallowRef(0);
  const setCurrent = writeRef(currentState);
  const urlsState = shallowRef<Map<string, string>>(new Map());
  const setUrls = writeRef(urlsState);
  const zoomImageState = shallowRef<{ src: string; label: string } | null>(null);
  const setZoomImage = writeRef(zoomImageState);
  const watchSlides = watchRender();

  return ({ presentation }) => {
    watchSlides(() => {
      const created = new Map<string, string>();
      for (const slide of presentation.slides) {
        slide.images.forEach((img, idx) => {
          const key = `${slide.index}:${idx}`;
          const blob = new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.mime });
          created.set(key, URL.createObjectURL(blob));
        });
      }
      setUrls(created);
      return () => {
        for (const url of created.values()) URL.revokeObjectURL(url);
      };
    }, [presentation]);

    const slides = presentation.slides;
    const active = Math.min(currentState.value, Math.max(0, slides.length - 1));
    const slide = slides[active];
    const urlMap = urlsState.value;

    return (
      <div class="fp-ppt">
        <div class="fp-subbar">
          <div class="fp-subbar-actions">
            <button
              type="button"
              disabled={active <= 0}
              onClick={() => setCurrent(Math.max(0, active - 1))}
            >
              上一页
            </button>
            <span class="fp-subbar-meta">
              第 {active + 1} / {slides.length} 页
            </span>
            <button
              type="button"
              disabled={active >= slides.length - 1}
              onClick={() => setCurrent(Math.min(slides.length - 1, active + 1))}
            >
              下一页
            </button>
          </div>
          {presentation.clippedSlides && (
            <span class="fp-subbar-meta">仅展示前 120 页</span>
          )}
        </div>
        <div class="fp-ppt-body">
          <nav class="fp-ppt-outline" aria-label="幻灯片目录">
            {slides.map((item, idx) => (
              <button
                key={item.index}
                type="button"
                class={`fp-ppt-thumb${idx === active ? ' active' : ''}`}
                onClick={() => setCurrent(idx)}
              >
                <span class="fp-ppt-num">{item.index}</span>
                <span class="fp-ppt-thumb-title">{item.title}</span>
              </button>
            ))}
          </nav>
          {slide && (
            <article class="fp-ppt-slide">
              <h3 class="fp-ppt-title">{slide.title}</h3>
              {slide.paragraphs.length > 0 && (
                <ul class="fp-ppt-list">
                  {slide.paragraphs.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
              {slide.images.length > 0 && (
                <div class="fp-ppt-images">
                  {slide.images.map((img, idx) => {
                    const src = urlMap.get(`${slide.index}:${idx}`);
                    if (!src) return null;
                    return (
                      <button
                        key={idx}
                        type="button"
                        class="fp-ppt-image-btn"
                        onClick={() => setZoomImage({ src, label: img.name })}
                      >
                        <img src={src} alt={img.name} loading="lazy" />
                      </button>
                    );
                  })}
                </div>
              )}
              {slide.paragraphs.length === 0 && slide.images.length === 0 && (
                <p class="fp-ppt-empty">本页无提取出的文字或图片内容。</p>
              )}
              {slide.notes.length > 0 && (
                <aside class="fp-ppt-notes">
                  <strong>演讲者备注</strong>
                  {slide.notes.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </aside>
              )}
            </article>
          )}
        </div>
        {zoomImageState.value && (
          <ImagePreview
            src={zoomImageState.value.src}
            label={zoomImageState.value.label}
            error=""
            reload={0}
            onClose={() => setZoomImage(null)}
            onError={() => {}}
            onRetry={() => {}}
          />
        )}
      </div>
    );
  };
});
